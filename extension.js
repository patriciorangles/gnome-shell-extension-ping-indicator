import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class PingIndicatorExtension extends Extension {
    enable() {
        this._indicator = new PingIndicator(this.path);
        Main.panel.addToStatusArea('ping-indicator', this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.stop();
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}

const PingIndicator = GObject.registerClass(
class PingIndicator extends PanelMenu.Button {
    _init(extensionPath) {
        // Corregido: Llamada a super() con los parámetros correctos
        super._init(0.0, "Ping Indicator", false);
        
        this._extensionPath = extensionPath;
        
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
        
        this.gateway = this._getDefaultGateway();
        
        this._updateIcons();
        this.timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 
            5, 
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
        if (!this.gateway) this.gateway = this._getDefaultGateway();
        
        const localPing = this.gateway ? this._pingHost(this.gateway) : -1;
        const internetPing = this._pingHost('google.com');
        
        let localIconName, tooltipText = "";
        
        // Icono local (diamante)
        if (localPing < 0) {
            localIconName = 'local-bad';
            tooltipText += `Router: Sin conexión\n`;
        } else if (localPing < 50) {
            localIconName = 'local-good';
            tooltipText += `Router: ${localPing} ms (Excelente)\n`;
        } else if (localPing < 100) {
            localIconName = 'local-medium';
            tooltipText += `Router: ${localPing} ms (Bueno)\n`;
        } else {
            localIconName = 'local-bad';
            tooltipText += `Router: ${localPing} ms (Crítico)\n`;
        }
        
        // Icono internet (círculo)
        let internetIconName;
        if (internetPing < 0) {
            internetIconName = 'internet-bad';
            tooltipText += `Internet: Sin conexión`;
        } else if (internetPing < 100) {
            internetIconName = 'internet-good';
            tooltipText += `Internet: ${internetPing} ms (Bueno)`;
        } else if (internetPing < 500) {
            internetIconName = 'internet-medium';
            tooltipText += `Internet: ${internetPing} ms (Aceptable)`;
        } else {
            internetIconName = 'internet-bad';
            tooltipText += `Internet: ${internetPing} ms (Crítico)`;
        }
        
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
        
        // CORRECCIÓN: Usar el método correcto para tooltips
        if (this.setTooltipText) {
            this.setTooltipText(tooltipText);
        } else {
            // Alternativa compatible
            this.tooltip_text = tooltipText;
        }
    }
    
    stop() {
        if (this.timeoutId) {
            GLib.source_remove(this.timeoutId);
            this.timeoutId = null;
        }
    }
    
    // Método para compatibilidad con diferentes versiones de GNOME
    setTooltipText(text) {
        if (super.set_tooltip_text) {
            super.set_tooltip_text(text);
        } else {
            this.tooltip_text = text;
        }
    }
});