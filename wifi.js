// Lado NetworkManager del monitoreo Wi-Fi: detecta cuándo la laptop cambia de
// punto de acceso dentro de la MISMA red (varios equipos emitiendo el mismo
// nombre, como un router + repetidor/mesh), lista los puntos de acceso
// visibles, permite fijar uno (o volver a automático) y conectarse a otra red.
//
// Fijar = escribir el BSSID en el perfil de conexión de NetworkManager
// (802-11-wireless.bssid) y reactivarlo — es lo mismo que
//   nmcli connection modify <perfil> 802-11-wireless.bssid <BSSID>
// Volver a automático = dejar ese campo vacío.
//
// La lógica pura (agrupar, detectar rebote, cuándo soltar un punto fijo) está
// en wifi-logic.js.

import NM from 'gi://NM';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {bandOf, channelOf, classifySwitch, shouldReleasePin, isPinWeak} from './wifi-logic.js';

// Tras fijar/soltar un punto de acceso, el cambio de punto que NetworkManager
// hace a continuación lo provocamos nosotros: durante esta ventana no se cuenta
// como salto espontáneo. 30 s cubre una reasociación lenta.
const SELF_SWITCH_WINDOW_SECONDS = 30;

// Mientras el usuario cambia de red desde el menú (puede tardar: hay que
// escribir la contraseña), las reglas automáticas que sueltan el punto fijo no
// deben meterse a "arreglar" la desconexión temporal.
const MANUAL_SWITCH_SECONDS = 120;

// NM_802_11_AP_FLAGS_PRIVACY: la red exige cifrado/contraseña.
const AP_FLAG_PRIVACY = 0x1;

const nowSeconds = () => GLib.get_monotonic_time() / 1000000;

function apInfo(ap) {
    if (!ap) return null;
    const ssidBytes = ap.get_ssid();
    const ssid = ssidBytes ? (NM.utils_ssid_to_utf8(ssidBytes.get_data()) || '') : '';
    const freq = ap.get_frequency();
    return {
        ssid,
        bssid: ap.get_bssid(),
        path: ap.get_path(),
        freq,
        band: bandOf(freq),
        channel: channelOf(freq),
        strength: ap.get_strength(),
        secured: (ap.get_flags() & AP_FLAG_PRIVACY) !== 0 || ap.get_wpa_flags() !== 0 || ap.get_rsn_flags() !== 0,
    };
}

export class WifiWatcher {
    // onRoam({time, ssid, from, to}) se llama en cada salto entre puntos de
    // acceso de la misma red. onLost() se llama cuando el Wi-Fi se queda sin
    // punto de acceso (desconexión). onSelfSwitch({time, ssid, from, to}) se
    // llama cuando el cambio de punto lo provocó la propia extensión (fijar o
    // soltar un punto): no cuenta como salto espontáneo.
    constructor(onRoam, onLost, onSelfSwitch) {
        this._onRoam = onRoam;
        this._onLost = onLost;
        this._onSelfSwitch = onSelfSwitch;
        this._suppressUntil = 0;
        this._manualSwitchUntil = 0;
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
        const kind = classifySwitch(this._lastKnown, current, nowSeconds(), this._suppressUntil);
        if (kind) {
            const ev = {
                time: nowSeconds(),
                ssid: current.ssid,
                from: this._lastKnown,
                to: current,
            };
            if (kind === 'self') {
                // Ya llegó el cambio que esperábamos: se cierra la ventana para
                // no ocultar un salto espontáneo que ocurra después.
                this._suppressUntil = 0;
                if (this._onSelfSwitch) this._onSelfSwitch(ev);
            } else {
                this._onRoam(ev);
            }
        }
        this._lastKnown = current;
    }

    _beginSelfSwitchWindow() {
        this._suppressUntil = nowSeconds() + SELF_SWITCH_WINDOW_SECONDS;
    }

    // ¿Hay un punto de acceso fijado en el perfil de la última conexión?
    hasPin() {
        const wireless = this._profile ? this._profile.get_setting_wireless() : null;
        return !!(wireless && wireless.get_bssid());
    }

    // ¿El Wi-Fi está sin punto de acceso ahora mismo?
    isDisconnected() {
        return !!this._device && !this._device.get_active_access_point();
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
        // El cambio de punto de acceso que sigue lo provocamos nosotros. Si algo
        // falla, la ventana se cierra para no ocultar saltos espontáneos.
        this._beginSelfSwitchWindow();
        const fail = e => {
            this._suppressUntil = 0;
            done(e);
        };
        wireless.bssid = bssid;
        remote.commit_changes_async(true, null, (_conn, res) => {
            try {
                remote.commit_changes_finish(res);
            } catch (e) {
                fail(e);
                return;
            }
            // Reactivar para que NetworkManager aplique el cambio ahora.
            this._client.activate_connection_async(remote, device, null, null, (_client, res2) => {
                try {
                    this._client.activate_connection_finish(res2);
                    done(null);
                } catch (e) {
                    fail(e);
                }
            });
        });
    }

    // Quita el BSSID fijado del perfil. activate = true reconecta de inmediato
    // (si ya hay otro punto de la misma red a la vista se conecta a él; si no
    // hay ninguno falla sin consecuencias y NetworkManager reintenta solo);
    // false solo guarda el cambio, para cuando se está por suspender y la
    // reconexión la hará NetworkManager al despertar. done(liberado, error).
    _unpinProfile(profile, activate, done) {
        const wireless = profile.get_setting_wireless();
        if (!wireless || !wireless.get_bssid()) {
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
            // La reconexión que sigue la provocamos nosotros (ver pin()).
            if (activate) this._beginSelfSwitchWindow();
            done(true, null);
            if (!activate || this._stopped || !this._client || !this._device) return;
            this._client.activate_connection_async(profile, this._device, null, null, (_client, res2) => {
                try {
                    this._client.activate_connection_finish(res2);
                } catch (e) { /* sin punto disponible todavía */ }
            });
        });
    }

    // Suelta el punto fijo del perfil actual sin condiciones (suspensión).
    releasePin(activate, done) {
        if (!this._profile) {
            done(false, null);
            return;
        }
        this._unpinProfile(this._profile, activate, done);
    }

    // Desconectado con un punto fijo: lo suelta si ya no está a la vista (o casi
    // sin señal) y, pasadas varias revisiones seguidas sin conectar, siempre
    // (ver shouldReleasePin). No toca nada si hay conexión, ni mientras el
    // usuario está cambiando de red a mano. done(liberado, error).
    releasePinIfLost(minStrength, checks, done) {
        const device = this._device;
        const profile = this._profile;
        const wireless = profile ? profile.get_setting_wireless() : null;
        if (!device || !wireless || nowSeconds() < this._manualSwitchUntil) {
            done(false, null);
            return;
        }
        const lost = shouldReleasePin({
            pinned: wireless.get_bssid(),
            aps: device.get_access_points().map(apInfo),
            connected: !!device.get_active_access_point(),
            checks,
        }, minStrength);
        if (!lost) {
            done(false, null);
            return;
        }
        this._unpinProfile(profile, true, done);
    }

    // ¿El punto fijo actual es malo (señal baja) habiendo otro de la misma red
    // mucho mejor? Ver isPinWeak.
    isPinWeak(weakBelow, margin) {
        const snap = this.snapshot();
        if (!snap) return false;
        return isPinWeak({pinned: snap.pinned, aps: snap.aps}, weakBelow, margin);
    }

    // Perfil de conexión Wi-Fi ya guardado en NetworkManager para esa red, o null.
    savedProfileFor(ssid) {
        if (!this._client) return null;
        for (const conn of this._client.get_connections()) {
            const wireless = conn.get_setting_wireless();
            if (!wireless) continue;
            const bytes = wireless.get_ssid();
            if (bytes && NM.utils_ssid_to_utf8(bytes.get_data()) === ssid) return conn;
        }
        return null;
    }

    // Conecta a otra red. apPath = punto de acceso a usar (el de mejor señal).
    // Con perfil guardado lo activa; sin perfil, NetworkManager crea uno para
    // ese punto de acceso y, si hace falta contraseña, la pide al agente de
    // GNOME Shell (el mismo diálogo del menú de red del sistema).
    // done(error|null, 'saved'|'new').
    connectTo(ssid, apPath, done) {
        const device = this._device;
        if (!device || !this._client) {
            done(new Error('no hay adaptador Wi-Fi'));
            return;
        }
        this._manualSwitchUntil = nowSeconds() + MANUAL_SWITCH_SECONDS;
        const fail = e => {
            this._manualSwitchUntil = 0;
            done(e);
        };

        const profile = this.savedProfileFor(ssid);
        if (profile) {
            this._client.activate_connection_async(profile, device, apPath, null, (_client, res) => {
                try {
                    this._client.activate_connection_finish(res);
                    done(null, 'saved');
                } catch (e) {
                    fail(e);
                }
            });
        } else {
            this._client.add_and_activate_connection_async(null, device, apPath, null, (_client, res) => {
                try {
                    this._client.add_and_activate_connection_finish(res);
                    done(null, 'new');
                } catch (e) {
                    fail(e);
                }
            });
        }
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
