// Lado NetworkManager del monitoreo Wi-Fi: detecta cuándo la laptop cambia de
// punto de acceso dentro de la MISMA red (varios equipos emitiendo el mismo
// nombre, como un router + repetidor/mesh), lista los puntos de acceso
// visibles y permite fijar uno (o volver a automático).
//
// Fijar = escribir el BSSID en el perfil de conexión de NetworkManager
// (802-11-wireless.bssid) y reactivarlo — es lo mismo que
//   nmcli connection modify <perfil> 802-11-wireless.bssid <BSSID>
// Volver a automático = dejar ese campo vacío.
//
// La lógica pura (agrupar, detectar rebote) está en wifi-logic.js.

import NM from 'gi://NM';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {bandOf, channelOf, sameNetworkSwitch, shouldReleasePin} from './wifi-logic.js';

function apInfo(ap) {
    if (!ap) return null;
    const ssidBytes = ap.get_ssid();
    const ssid = ssidBytes ? (NM.utils_ssid_to_utf8(ssidBytes.get_data()) || '') : '';
    const freq = ap.get_frequency();
    return {
        ssid,
        bssid: ap.get_bssid(),
        freq,
        band: bandOf(freq),
        channel: channelOf(freq),
        strength: ap.get_strength(),
    };
}

export class WifiWatcher {
    // onRoam({time, ssid, from, to}) se llama en cada salto entre puntos de
    // acceso de la misma red. onLost() se llama cuando el Wi-Fi se queda sin
    // punto de acceso (desconexión).
    constructor(onRoam, onLost) {
        this._onRoam = onRoam;
        this._onLost = onLost;
        this._client = null;
        this._device = null;
        // Último perfil de conexión visto mientras había conexión. Hace falta
        // guardarlo: al desconectarse ya no hay "conexión activa" de donde
        // sacarlo, y justo entonces es cuando se quiere soltar el punto fijo.
        this._profile = null;
        this._deviceSignal = 0;
        this._clientSignals = [];
        this._lastKnown = null;
        this._stopped = false;
    }

    start() {
        NM.Client.new_async(null, (_source, res) => {
            if (this._stopped) return;
            try {
                this._client = NM.Client.new_finish(res);
            } catch (e) {
                console.error(`[ping-indicator] Wi-Fi: no se pudo conectar con NetworkManager: ${e}`);
                return;
            }
            this._clientSignals.push(this._client.connect('device-added', () => this._pickDevice()));
            this._clientSignals.push(this._client.connect('device-removed', () => this._pickDevice()));
            this._pickDevice();
        });
    }

    _pickDevice() {
        if (this._stopped || !this._client) return;
        const wifi = this._client.get_devices()
            .find(d => d.get_device_type() === NM.DeviceType.WIFI) || null;
        if (wifi === this._device) return;

        this._disconnectDeviceSignal();
        this._device = wifi;
        this._lastKnown = null;
        if (wifi) {
            this._lastKnown = apInfo(wifi.get_active_access_point());
            this._deviceSignal = wifi.connect('notify::active-access-point',
                () => this._onActiveApChanged());
        }
    }

    _onActiveApChanged() {
        if (this._stopped || !this._device) return;
        const current = apInfo(this._device.get_active_access_point());
        // Desconectado un instante: se conserva el último punto conocido para
        // poder detectar el salto cuando vuelva a conectar a otro.
        if (!current) {
            if (this._onLost) this._onLost();
            return;
        }
        const activeConn = this._device.get_active_connection();
        if (activeConn && activeConn.get_connection()) {
            this._profile = activeConn.get_connection();
        }
        if (sameNetworkSwitch(this._lastKnown, current)) {
            this._onRoam({
                time: GLib.get_monotonic_time() / 1000000,
                ssid: current.ssid,
                from: this._lastKnown,
                to: current,
            });
        }
        this._lastKnown = current;
    }

    // Foto del momento: red actual, punto de acceso fijado (si hay) y todos
    // los puntos de acceso visibles. null si no hay adaptador Wi-Fi.
    snapshot() {
        const device = this._device;
        if (!device) return null;
        const active = apInfo(device.get_active_access_point());
        const activeConn = device.get_active_connection();
        const remote = activeConn ? activeConn.get_connection() : null;
        const wireless = remote ? remote.get_setting_wireless() : null;
        const pinned = wireless ? wireless.get_bssid() : null;
        if (remote) this._profile = remote;
        const aps = device.get_access_points().map(ap => {
            const info = apInfo(ap);
            info.active = !!active && info.bssid === active.bssid;
            return info;
        });
        return {
            ssid: active ? active.ssid : null,
            active,
            pinned: pinned ? pinned.toUpperCase() : null,
            connectionId: remote ? remote.get_id() : null,
            aps,
        };
    }

    // bssid = null vuelve a modo automático. done(error|null) al terminar.
    pin(bssid, done) {
        const device = this._device;
        const activeConn = device ? device.get_active_connection() : null;
        const remote = activeConn ? activeConn.get_connection() : null;
        const wireless = remote ? remote.get_setting_wireless() : null;
        if (!remote || !wireless) {
            done(new Error('no hay una conexión Wi-Fi activa'));
            return;
        }

        this._profile = remote;
        wireless.bssid = bssid;
        remote.commit_changes_async(true, null, (_conn, res) => {
            try {
                remote.commit_changes_finish(res);
            } catch (e) {
                done(e);
                return;
            }
            // Reactivar para que NetworkManager aplique el cambio ahora.
            this._client.activate_connection_async(remote, device, null, null, (_client, res2) => {
                try {
                    this._client.activate_connection_finish(res2);
                    done(null);
                } catch (e) {
                    done(e);
                }
            });
        });
    }

    // Si el Wi-Fi está desconectado y el punto de acceso fijo ya no está a la
    // vista (o casi sin señal), vuelve el perfil a automático. done(liberado,
    // error). No toca nada si hay conexión o si el punto fijo sigue al alcance.
    releasePinIfLost(minStrength, done) {
        const device = this._device;
        const profile = this._profile;
        const wireless = profile ? profile.get_setting_wireless() : null;
        if (!device || !wireless) {
            done(false, null);
            return;
        }
        const lost = shouldReleasePin({
            pinned: wireless.get_bssid(),
            aps: device.get_access_points().map(apInfo),
            connected: !!device.get_active_access_point(),
        }, minStrength);
        if (!lost) {
            done(false, null);
            return;
        }

        wireless.bssid = null;
        profile.commit_changes_async(true, null, (_conn, res) => {
            try {
                profile.commit_changes_finish(res);
            } catch (e) {
                done(false, e);
                return;
            }
            done(true, null);
            // Si ya hay otro punto de la misma red a la vista, conectar ahora.
            // Si no hay ninguno, falla y no pasa nada: NetworkManager reintenta
            // solo cuando aparezca uno.
            if (this._stopped || !this._client) return;
            this._client.activate_connection_async(profile, device, null, null, (_client, res2) => {
                try {
                    this._client.activate_connection_finish(res2);
                } catch (e) { /* sin punto disponible todavía */ }
            });
        });
    }

    // OJO: en NM.Device, disconnect() es un método propio (desconectar el
    // dispositivo de la red) que tapa al disconnect(id) de señales de GObject.
    // Por eso se usa GObject.signal_handler_disconnect — con device.disconnect(id)
    // da "Expected an object of type GCancellable".
    _disconnectDeviceSignal() {
        if (this._device && this._deviceSignal) {
            GObject.signal_handler_disconnect(this._device, this._deviceSignal);
        }
        this._deviceSignal = 0;
    }

    stop() {
        this._stopped = true;
        this._disconnectDeviceSignal();
        this._device = null;
        if (this._client) {
            this._clientSignals.forEach(id => GObject.signal_handler_disconnect(this._client, id));
        }
        this._clientSignals = [];
        this._client = null;
        this._profile = null;
    }
}
