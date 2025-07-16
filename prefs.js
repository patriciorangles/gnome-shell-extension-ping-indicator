import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PrefsKeys = {
    // Configuración existente
    REFRESH_INTERVAL: 'refresh-interval',
    GATEWAY_ADDRESS: 'gateway-address',
    INTERNET_ADDRESS: 'internet-address',
    
    // Nuevos umbrales
    LOCAL_GOOD_THRESHOLD: 'local-good-threshold',
    LOCAL_MEDIUM_THRESHOLD: 'local-medium-threshold',
    INTERNET_GOOD_THRESHOLD: 'internet-good-threshold',
    INTERNET_MEDIUM_THRESHOLD: 'internet-medium-threshold'
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
            title: _('Intervalo (segundos)'),
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
        
        // Ensamblar páginas
        generalPage.add(generalGroup);
        thresholdsPage.add(localThresholdsGroup);
        thresholdsPage.add(internetThresholdsGroup);
        
        window.add(generalPage);
        window.add(thresholdsPage);
    }
}