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
    SHOW_NUMERIC_LABELS: 'show-numeric-labels'
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

        // Ensamblar páginas
        generalPage.add(generalGroup);
        thresholdsPage.add(localThresholdsGroup);
        thresholdsPage.add(internetThresholdsGroup);
        stabilityPage.add(burstGroup);
        stabilityPage.add(localStabilityGroup);
        stabilityPage.add(internetStabilityGroup);
        stabilityPage.add(mtrGroup);

        window.add(generalPage);
        window.add(thresholdsPage);
        window.add(stabilityPage);
    }
}