import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class PingIndicatorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new PingIndicator(this.path, this._settings);
        Main.panel.addToStatusArea('ping-indicator', this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.stop();
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
    }
}

const PingIndicator = GObject.registerClass(
class PingIndicator extends PanelMenu.Button {
    _init(extensionPath, settings) {
        super._init(0.0, "Ping Indicator", false);
        
        this._extensionPath = extensionPath;
        this._settings = settings;
        
        // Almacenar los últimos valores
        this._lastLocalPing = -1;
        this._lastInternetPing = -1;
        this._lastUpdate = new Date();
        
        this.box = new St.BoxLayout({
            style_class: 'dual-ping-box'
        });
        
        this.localIcon = new St.Icon({
            icon_size: 18,
            style_class: 'system-status-icon'
        });
        
        this.internetIcon = new St.Icon({
            icon_size: 18,
            style_class: 'system-status-icon'
        });
        
        this.box.add_child(this.localIcon);
        this.box.add_child(this.internetIcon);
        this.add_child(this.box);
        
        // Crear menú de configuración (forma compatible)
        this.configItem = new PopupMenu.PopupMenuItem("Configuración");
        this.configItem.connect('activate', () => {
            Util.spawnCommandLine('gnome-extensions prefs ping-indicator@patriciorangles');
        });
        this.menu.addMenuItem(this.configItem);

        // // Item de intervalo
        // this.intervalItem = new PopupMenu.PopupMenuItem("Intervalo: " + this._settings.get_int('refresh-interval') + "s");
        // this.intervalItem.connect('activate', () => {
        //     const currentValue = this._settings.get_int('refresh-interval');
        //     const newValue = currentValue < 60 ? currentValue + 5 : 5;
        //     this._settings.set_int('refresh-interval', newValue);
        //     this.intervalItem.label.text = "Intervalo: " + newValue + "s";
        //     this._scheduleNextUpdate();
        // });
        //this.menu.addMenuItem(this.intervalItem);

        // Separador
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Estado actual
        this.statusItem = new PopupMenu.PopupMenuItem("Cargando...");
        this.statusItem.actor.reactive = false;
        this.menu.addMenuItem(this.statusItem);
        
            // Tooltip dinámico
            this._dynamicTooltipId = 0;
            this.connect('notify::hover', () => {
                if (this.hover) {
                    this._startDynamicTooltip();
                } else {
                    this._stopDynamicTooltip();
                }
            });
            
            // Inicializar con valores vacíos
            this.gateway = null;
            
            // Actualizar inmediatamente y luego periódicamente
            this._updateIcons();
            this._scheduleNextUpdate();

            this._settingsHandler = this._settings.connect(
                'changed::refresh-interval',
                () => this._scheduleNextUpdate()
            );
    }
    
    _scheduleNextUpdate() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        
        const interval = this._settings.get_int('refresh-interval');
        
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 
            interval, 
            () => {
                this._updateIcons();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }
    
    _getDefaultGateway() {
        try {
            const [success, output] = GLib.spawn_command_line_sync('ip route show default');
            if (!success) return null;
            
            const decoder = new TextDecoder();
            const outputStr = decoder.decode(output);
            const match = outputStr.match(/default via (\d+\.\d+\.\d+\.\d+)/);
            return match ? match[1] : null;
        } catch (e) {
            console.error(`Error obteniendo gateway: ${e}`);
            return null;
        }
    }
    
    _pingHost(host) {
        try {
            const [success, output] = GLib.spawn_command_line_sync(`ping -c 1 -W 1 ${host}`);
            if (!success) return -1;
            
            const decoder = new TextDecoder();
            const outputStr = decoder.decode(output);
            const match = outputStr.match(/time=([0-9.]+)\s?ms/);
            return match ? parseFloat(match[1]) : -1;
        } catch (e) {
            console.error(`Error en ping (${host}): ${e}`);
            return -1;
        }
    }
    
    _updateIcons() {
        const gatewayAddress = this._settings.get_string('gateway-address');
        const internetAddress = this._settings.get_string('internet-address');
        
        if (!gatewayAddress || gatewayAddress === '') {
            if (!this.gateway) {
                this.gateway = this._getDefaultGateway();
            }
        } else {
            this.gateway = gatewayAddress;
        }
        
        const localPing = this.gateway ? this._pingHost(this.gateway) : -1;
        const internetPing = this._pingHost(internetAddress || 'google.com');
        
        this._lastLocalPing = localPing;
        this._lastInternetPing = internetPing;
        this._lastUpdate = new Date();
        
        this._updateIconsAndTooltip();
        
        //const elapsed = Math.floor((new Date() - this._lastUpdate) / 1000);
        //this.statusItem.label.text = `Última actualización: hace ${elapsed} segundos\n` +
        //                            `Router: ${localPing >= 0 ? localPing + ' ms' : 'N/A'}\n` +
        //                            `Internet: ${internetPing >= 0 ? internetPing + ' ms' : 'N/A'}`;
        this.statusItem.label.text = `Router: ${localPing >= 0 ? localPing + ' ms' : 'N/A'}\n` +
                                    `Internet: ${internetPing >= 0 ? internetPing + ' ms' : 'N/A'}`;
    }
    
    _updateIconsAndTooltip() {
        // Obtener umbrales de configuración
        const localGood = this._settings.get_int('local-good-threshold');
        const localMedium = this._settings.get_int('local-medium-threshold');
        const internetGood = this._settings.get_int('internet-good-threshold');
        const internetMedium = this._settings.get_int('internet-medium-threshold');
        
        let localIconName, tooltipText = "";
        
        // Determinar icono local basado en umbrales
        if (this._lastLocalPing < 0) {
            localIconName = 'local-bad';
            tooltipText += `Router: Sin conexión\n`;
        } else if (this._lastLocalPing < localGood) {
            localIconName = 'local-good';
            tooltipText += `Router: ${this._lastLocalPing} ms (Excelente)\n`;
        } else if (this._lastLocalPing < localMedium) {
            localIconName = 'local-medium';
            tooltipText += `Router: ${this._lastLocalPing} ms (Bueno)\n`;
        } else {
            localIconName = 'local-bad';
            tooltipText += `Router: ${this._lastLocalPing} ms (Crítico)\n`;
        }
        
        // Determinar icono de internet basado en umbrales
        let internetIconName;
        if (this._lastInternetPing < 0) {
            internetIconName = 'internet-bad';
            tooltipText += `Internet: Sin conexión`;
        } else if (this._lastInternetPing < internetGood) {
            internetIconName = 'internet-good';
            tooltipText += `Internet: ${this._lastInternetPing} ms (Bueno)`;
        } else if (this._lastInternetPing < internetMedium) {
            internetIconName = 'internet-medium';
            tooltipText += `Internet: ${this._lastInternetPing} ms (Aceptable)`;
        } else {
            internetIconName = 'internet-bad';
            tooltipText += `Internet: ${this._lastInternetPing} ms (Crítico)`;
        }
        
        // Aplicar iconos
        try {
            this.localIcon.set_gicon(
                Gio.icon_new_for_string(`${this._extensionPath}/icons/${localIconName}.svg`)
            );
            
            this.internetIcon.set_gicon(
                Gio.icon_new_for_string(`${this._extensionPath}/icons/${internetIconName}.svg`)
            );
        } catch (e) {
            console.error(`Error cargando iconos: ${e}`);
        }
        
        this.setTooltipText(tooltipText);
    }
    
    _startDynamicTooltip() {
        if (this._dynamicTooltipId) return;
        
        this._dynamicTooltipId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1,
            () => {
                this._updateDynamicTooltip();
                return GLib.SOURCE_CONTINUE;
            }
        );
        
        this._updateDynamicTooltip();
    }
    
    _stopDynamicTooltip() {
        if (this._dynamicTooltipId) {
            GLib.source_remove(this._dynamicTooltipId);
            this._dynamicTooltipId = null;
        }
    }
    
    _updateDynamicTooltip() {
        const elapsed = Math.floor((new Date() - this._lastUpdate) / 1000);
        const tooltipText = `Última actualización: hace ${elapsed} segundos\n` +
                           `Router: ${this._lastLocalPing >= 0 ? this._lastLocalPing + ' ms' : 'N/A'}\n` +
                           `Internet: ${this._lastInternetPing >= 0 ? this._lastInternetPing + ' ms' : 'N/A'}`;
        
        this.setTooltipText(tooltipText);
    }
    
    stop() {
        if (this._settingsHandler) {
            this._settings.disconnect(this._settingsHandler);
            this._settingsHandler = null;
        }    
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        this._stopDynamicTooltip();
    }
    
    setTooltipText(text) {
        if (super.set_tooltip_text) {
            super.set_tooltip_text(text);
        } else {
            this.tooltip_text = text;
        }
    }
});