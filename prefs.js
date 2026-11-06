import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PrefsKeys = {
    // Configuración existente
    REFRESH_INTERVAL: 'refresh-interval',
    REFRESH_INTERVAL_UNSTABLE: 'refresh-interval-unstable',
    GATEWAY_ADDRESS: 'gateway-address',
    INTERNET_ADDRESS: 'internet-address',
    
    // Nuevos umbrales
    LOCAL_GOOD_THRESHOLD: 'local-good-threshold',
    LOCAL_MEDIUM_THRESHOLD: 'local-medium-threshold',
    INTERNET_GOOD_THRESHOLD: 'internet-good-threshold',
    INTERNET_MEDIUM_THRESHOLD: 'internet-medium-threshold',

    // Ráfaga / estabilidad (jitter y pérdida)
    PING_COUNT: 'ping-count',
    LOCAL_LOSS_THRESHOLD: 'local-loss-threshold',
    LOCAL_JITTER_THRESHOLD: 'local-jitter-threshold',
    INTERNET_LOSS_THRESHOLD: 'internet-loss-threshold',
    INTERNET_JITTER_THRESHOLD: 'internet-jitter-threshold',

    // Diagnóstico automático mtr
    MTR_ENABLED: 'mtr-enabled',
    MTR_COOLDOWN: 'mtr-cooldown',

    // Presentación
    SHOW_NUMERIC_LABELS: 'show-numeric-labels',

    // Wi-Fi: saltos entre puntos de acceso de la misma red
    WIFI_WATCH_ENABLED: 'wifi-watch-enabled',
    ROAM_FLAP_THRESHOLD: 'roam-flap-threshold',
    ROAM_FLAP_WINDOW: 'roam-flap-window',
    PIN_AUTO_RELEASE: 'pin-auto-release',
    PIN_RELEASE_DELAY: 'pin-release-delay',
    PIN_RELEASE_ON_SLEEP: 'pin-release-on-sleep',

    // Novedades: confirmación de cambios de estado
    STATE_CONFIRMATIONS: 'state-confirmations',
    OUTAGE_ENTER_CONFIRMATIONS: 'outage-enter-confirmations',
    OUTAGE_LEAVE_CONFIRMATIONS: 'outage-leave-confirmations'
};

export default class PingIndicatorPreferences extends ExtensionPreferences {
    _init() {
        super._init();
    }

    fillPreferencesWindow(window) {
        // Crear páginas separadas
        const generalPage = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic'
        });
        
        const thresholdsPage = new Adw.PreferencesPage({
            title: _('Umbrales'),
            icon_name: 'dialog-warning-symbolic'
        });

        const stabilityPage = new Adw.PreferencesPage({
            title: _('Estabilidad'),
            icon_name: 'network-cellular-signal-weak-symbolic'
        });

        // Grupo para configuración general
        const generalGroup = new Adw.PreferencesGroup({
            title: _('Configuración de Red'),
            description: _('Ajustes básicos para el monitoreo')
        });
        
        // Grupo para umbrales locales
        const localThresholdsGroup = new Adw.PreferencesGroup({
            title: _('Umbrales Locales'),
            description: _('Límites para el ping al router')
        });
        
        // Grupo para umbrales de internet
        const internetThresholdsGroup = new Adw.PreferencesGroup({
            title: _('Umbrales de Internet'),
            description: _('Límites para el ping a internet')
        });
        
        const settings = this.getSettings();
        
        // 1. Configuración General
        const intervalRow = new Adw.SpinRow({
            title: _('Intervalo normal (segundos)'),
            subtitle: _('Cadencia cuando todo está bien — ya no hace falta que sea alto solo para evitar que la máquina se ponga lenta'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1
            }),
            digits: 0
        });
        settings.bind(
            PrefsKeys.REFRESH_INTERVAL,
            intervalRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(intervalRow);

        const intervalUnstableRow = new Adw.SpinRow({
            title: _('Intervalo mientras hay problemas (segundos)'),
            subtitle: _('Cadencia más rápida SOLO mientras router o internet estén en Inestable/Crítico — nunca más lenta que el intervalo normal'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1
            }),
            digits: 0
        });
        settings.bind(
            PrefsKeys.REFRESH_INTERVAL_UNSTABLE,
            intervalUnstableRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(intervalUnstableRow);

        const gatewayRow = new Adw.ActionRow({
            title: _('Dirección del Router')
        });
        const gatewayEntry = new Gtk.Entry({
            placeholder_text: _('Auto-detect'),
            hexpand: true
        });
        gatewayRow.add_suffix(gatewayEntry);
        settings.bind(
            PrefsKeys.GATEWAY_ADDRESS,
            gatewayEntry,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(gatewayRow);
        
        const internetRow = new Adw.ActionRow({
            title: _('Servidor de Internet')
        });
        const internetEntry = new Gtk.Entry({
            placeholder_text: _('Ej: 8.8.8.8'),
            hexpand: true
        });
        internetRow.add_suffix(internetEntry);
        settings.bind(
            PrefsKeys.INTERNET_ADDRESS,
            internetEntry,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(internetRow);

        const showLabelsRow = new Adw.SwitchRow({
            title: _('Mostrar el número de latencia junto al ícono'),
            subtitle: _('Igual que CPU/batería en el panel — se puede apagar si prefieres solo el ícono')
        });
        settings.bind(PrefsKeys.SHOW_NUMERIC_LABELS, showLabelsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(showLabelsRow);

        // 2. Umbrales Locales
        const localGoodRow = new Adw.SpinRow({
            title: _('Bueno (ms)'),
            subtitle: _('Ping menor que este valor mostrará icono verde'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 1000,
                step_increment: 1
            }),
            digits: 0
        });
        settings.bind(
            PrefsKeys.LOCAL_GOOD_THRESHOLD,
            localGoodRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        localThresholdsGroup.add(localGoodRow);
        
        const localMediumRow = new Adw.SpinRow({
            title: _('Medio (ms)'),
            subtitle: _('Ping menor que este valor pero mayor que "Bueno" mostrará icono amarillo'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 1000,
                step_increment: 1
            }),
            digits: 0
        });
        settings.bind(
            PrefsKeys.LOCAL_MEDIUM_THRESHOLD,
            localMediumRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        localThresholdsGroup.add(localMediumRow);
        
        // 3. Umbrales de Internet
        const internetGoodRow = new Adw.SpinRow({
            title: _('Bueno (ms)'),
            subtitle: _('Ping menor que este valor mostrará icono verde'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 2000,
                step_increment: 1
            }),
            digits: 0
        });
        settings.bind(
            PrefsKeys.INTERNET_GOOD_THRESHOLD,
            internetGoodRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        internetThresholdsGroup.add(internetGoodRow);
        
        const internetMediumRow = new Adw.SpinRow({
            title: _('Medio (ms)'),
            subtitle: _('Ping menor que este valor pero mayor que "Bueno" mostrará icono amarillo'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 2000,
                step_increment: 1
            }),
            digits: 0
        });
        settings.bind(
            PrefsKeys.INTERNET_MEDIUM_THRESHOLD,
            internetMediumRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        internetThresholdsGroup.add(internetMediumRow);

        // 4. Ráfaga de pings
        const burstGroup = new Adw.PreferencesGroup({
            title: _('Ráfaga de pings'),
            description: _('Un solo ping no detecta cortes intermitentes; se manda una ráfaga y se mide pérdida y variación (jitter), no solo el promedio')
        });

        const pingCountRow = new Adw.SpinRow({
            title: _('Pings por ráfaga'),
            subtitle: _('Más pings dan una medición más confiable, pero tardan un poco más cada ciclo'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 20,
                step_increment: 1
            }),
            digits: 0
        });
        settings.bind(
            PrefsKeys.PING_COUNT,
            pingCountRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        burstGroup.add(pingCountRow);

        // 5. Umbrales de inestabilidad — local
        const localStabilityGroup = new Adw.PreferencesGroup({
            title: _('Inestabilidad — Router'),
            description: _('Si se cruza cualquiera de los dos, se marca "Inestable" aunque el promedio de latencia se vea bien')
        });

        const localLossRow = new Adw.SpinRow({
            title: _('Pérdida de paquetes (%)'),
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 100, step_increment: 1 }),
            digits: 0
        });
        settings.bind(PrefsKeys.LOCAL_LOSS_THRESHOLD, localLossRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        localStabilityGroup.add(localLossRow);

        const localJitterRow = new Adw.SpinRow({
            title: _('Jitter / variación (ms)'),
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 2000, step_increment: 1 }),
            digits: 0
        });
        settings.bind(PrefsKeys.LOCAL_JITTER_THRESHOLD, localJitterRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        localStabilityGroup.add(localJitterRow);

        // 6. Umbrales de inestabilidad — internet
        const internetStabilityGroup = new Adw.PreferencesGroup({
            title: _('Inestabilidad — Internet')
        });

        const internetLossRow = new Adw.SpinRow({
            title: _('Pérdida de paquetes (%)'),
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 100, step_increment: 1 }),
            digits: 0
        });
        settings.bind(PrefsKeys.INTERNET_LOSS_THRESHOLD, internetLossRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        internetStabilityGroup.add(internetLossRow);

        const internetJitterRow = new Adw.SpinRow({
            title: _('Jitter / variación (ms)'),
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 2000, step_increment: 1 }),
            digits: 0
        });
        settings.bind(PrefsKeys.INTERNET_JITTER_THRESHOLD, internetJitterRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        internetStabilityGroup.add(internetJitterRow);

        // 7. Diagnóstico automático (mtr)
        const mtrGroup = new Adw.PreferencesGroup({
            title: _('Diagnóstico automático (mtr)'),
            description: _('Cuando Internet se marca inestable o crítico, corre un mtr en segundo plano para ubicar en qué salto de red está el problema')
        });

        const mtrEnabledRow = new Adw.SwitchRow({
            title: _('Activar diagnóstico automático'),
            subtitle: _('Requiere tener "mtr" instalado')
        });
        settings.bind(PrefsKeys.MTR_ENABLED, mtrEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        mtrGroup.add(mtrEnabledRow);

        const mtrCooldownRow = new Adw.SpinRow({
            title: _('Espera entre diagnósticos (segundos)'),
            subtitle: _('Evita correr mtr en cada ciclo mientras la inestabilidad persiste'),
            adjustment: new Gtk.Adjustment({ lower: 30, upper: 3600, step_increment: 30 }),
            digits: 0
        });
        settings.bind(PrefsKeys.MTR_COOLDOWN, mtrCooldownRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        mtrGroup.add(mtrCooldownRow);

        // 8a. Novedades: cuántas mediciones seguidas confirman un cambio de estado
        const confirmGroup = new Adw.PreferencesGroup({
            title: _('Novedades: confirmación de cambios'),
            description: _('Cuántas mediciones seguidas deben repetirse para que un cambio de estado se anote en "Novedades" y en el journal. Más mediciones = menos ruido pero se anota más tarde; el ícono del panel siempre cambia en tiempo real. Con 1 se anota al instante.')
        });

        const stateConfirmRow = new Adw.SpinRow({
            title: _('Cambios de nivel o de inestabilidad'),
            subtitle: _('Para vaivenes alrededor de un umbral (p. ej. Excelente ↔ Aceptable)'),
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 10, step_increment: 1 }),
            digits: 0
        });
        settings.bind(PrefsKeys.STATE_CONFIRMATIONS, stateConfirmRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        confirmGroup.add(stateConfirmRow);

        const outageEnterRow = new Adw.SpinRow({
            title: _('Corte total: confirmar con (ráfagas sin respuesta)'),
            subtitle: _('Con 1 se anota al primer ping fallido, pero un microcorte de ~1 s también contaría'),
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 10, step_increment: 1 }),
            digits: 0
        });
        settings.bind(PrefsKeys.OUTAGE_ENTER_CONFIRMATIONS, outageEnterRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        confirmGroup.add(outageEnterRow);

        const outageLeaveRow = new Adw.SpinRow({
            title: _('Recuperación del corte: confirmar con (ráfagas que responden)'),
            subtitle: _('Con 1 se anota en cuanto vuelve a responder'),
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 10, step_increment: 1 }),
            digits: 0
        });
        settings.bind(PrefsKeys.OUTAGE_LEAVE_CONFIRMATIONS, outageLeaveRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        confirmGroup.add(outageLeaveRow);

        // 8. Wi-Fi: saltos entre puntos de acceso
        const wifiGroup = new Adw.PreferencesGroup({
            title: _('Wi-Fi: saltos entre puntos de acceso'),
            description: _('Cuando varios equipos (router + repetidor/mesh) emiten la misma red y la laptop salta entre ellos, la conexión se corta unos segundos en cada salto. Aquí se define cuándo avisarlo con un ícono en el panel; desde el menú → Wi-Fi puedes fijar un punto de acceso.')
        });

        const wifiEnabledRow = new Adw.SwitchRow({
            title: _('Vigilar saltos entre puntos de acceso'),
            subtitle: _('Muestra el submenú Wi-Fi y el ícono de aviso')
        });
        settings.bind(PrefsKeys.WIFI_WATCH_ENABLED, wifiEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        wifiGroup.add(wifiEnabledRow);

        const roamThresholdRow = new Adw.SpinRow({
            title: _('Saltos para avisar'),
            subtitle: _('Cuántos saltos dentro de la ventana cuentan como rebote'),
            adjustment: new Gtk.Adjustment({ lower: 2, upper: 20, step_increment: 1 }),
            digits: 0
        });
        settings.bind(PrefsKeys.ROAM_FLAP_THRESHOLD, roamThresholdRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        wifiGroup.add(roamThresholdRow);

        const roamWindowRow = new Adw.SpinRow({
            title: _('Ventana de detección (segundos)'),
            subtitle: _('El ícono se apaga solo cuando los saltos salen de esta ventana'),
            adjustment: new Gtk.Adjustment({ lower: 30, upper: 3600, step_increment: 30 }),
            digits: 0
        });
        settings.bind(PrefsKeys.ROAM_FLAP_WINDOW, roamWindowRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        wifiGroup.add(roamWindowRow);

        const pinSleepRow = new Adw.SwitchRow({
            title: _('Soltar el punto fijo al suspender'),
            subtitle: _('Un punto fijo es una ayuda para la sesión: al cerrar la tapa puedes despertar en otro lugar, junto al otro punto de acceso, donde el fijo ya no serviría')
        });
        settings.bind(PrefsKeys.PIN_RELEASE_ON_SLEEP, pinSleepRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        wifiGroup.add(pinSleepRow);

        const pinReleaseRow = new Adw.SwitchRow({
            title: _('Soltar el punto fijo cuando deje de servir'),
            subtitle: _('Con un punto fijo el Wi-Fi no se conecta al otro punto de la misma red. Se vuelve solo a automático si te quedas sin conexión con él (no está al alcance) o si lo tienes con señal débil habiendo otro mucho mejor')
        });
        settings.bind(PrefsKeys.PIN_AUTO_RELEASE, pinReleaseRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        wifiGroup.add(pinReleaseRow);

        const pinReleaseDelayRow = new Adw.SpinRow({
            title: _('Espera antes de soltarlo (segundos)'),
            subtitle: _('Tiempo desconectado antes de comprobar si el punto fijo sigue al alcance. Si sigue sin conectar, se vuelve a revisar con la misma cadencia y la 2ª revisión lo suelta siempre'),
            adjustment: new Gtk.Adjustment({ lower: 5, upper: 300, step_increment: 5 }),
            digits: 0
        });
        settings.bind(PrefsKeys.PIN_RELEASE_DELAY, pinReleaseDelayRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        wifiGroup.add(pinReleaseDelayRow);

        // Ensamblar páginas
        generalPage.add(generalGroup);
        thresholdsPage.add(localThresholdsGroup);
        thresholdsPage.add(internetThresholdsGroup);
        stabilityPage.add(burstGroup);
        stabilityPage.add(localStabilityGroup);
        stabilityPage.add(internetStabilityGroup);
        stabilityPage.add(confirmGroup);
        stabilityPage.add(mtrGroup);
        stabilityPage.add(wifiGroup);

        window.add(generalPage);
        window.add(thresholdsPage);
        window.add(stabilityPage);
    }
}