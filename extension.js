import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {runCommandAsync, pingBurst, parseMtrHops, findWorstHop, latencyTier, isUnstable} from './netcheck.js';

// Orden de severidad de cada tier, para saber si un cambio es una mejora o
// un empeoramiento (y decidir el nivel del log: info al mejorar, warning al
// empeorar).
const TIER_RANK = {good: 0, medium: 1, bad: 2};
const TIER_LABEL = {good: 'Excelente', medium: 'Aceptable', bad: 'Crítico'};
const LEVEL_ICON = {info: 'ℹ', warning: '⚠', error: '⛔'};

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
        this._lastLocalStats = null;
        this._lastInternetStats = null;
        this._lastUpdate = new Date();

        // Diagnóstico mtr automático
        this._mtrRunning = false;
        this._lastMtrTime = 0;
        this._lastMtrSummary = null;
        this._mtrAvailable = true;

        // Historial de novedades (cambios de estado) para el submenú y para
        // el log del sistema. null en los "prev" significa "todavía no hay
        // una primera medición con la que comparar" — así el primer ciclo no
        // genera un falso "cambio".
        this._history = [];
        this._maxHistory = 30;
        this._prevLocalTier = null;
        this._prevInternetTier = null;
        this._prevLocalUnstable = false;
        this._prevInternetUnstable = false;

        this.box = new St.BoxLayout({
            style_class: 'dual-ping-box'
        });

        // Cada grupo (ícono + número) es un BoxLayout aparte, con menos
        // espacio interno que el que separa router de internet.
        this.localGroup = new St.BoxLayout({style_class: 'ping-group'});
        this.internetGroup = new St.BoxLayout({style_class: 'ping-group'});

        this.localIcon = new St.Icon({
            icon_size: 18,
            style_class: 'system-status-icon'
        });

        this.internetIcon = new St.Icon({
            icon_size: 18,
            style_class: 'system-status-icon'
        });

        this.localLabel = new St.Label({
            style_class: 'ping-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.internetLabel = new St.Label({
            style_class: 'ping-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.localGroup.add_child(this.localIcon);
        this.localGroup.add_child(this.localLabel);
        this.internetGroup.add_child(this.internetIcon);
        this.internetGroup.add_child(this.internetLabel);

        this.box.add_child(this.localGroup);
        this.box.add_child(this.internetGroup);
        this.add_child(this.box);

        // Crear menú de configuración (forma compatible)
        this.configItem = new PopupMenu.PopupMenuItem("Configuración");
        this.configItem.connect('activate', () => {
            Util.spawnCommandLine('gnome-extensions prefs ping-indicator@patriciorangles');
        });
        this.menu.addMenuItem(this.configItem);

        // Separador
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Estado actual
        this.statusItem = new PopupMenu.PopupMenuItem("Cargando...");
        this.statusItem.actor.reactive = false;
        this.statusItem.label.clutter_text.set_line_wrap(true);
        this.menu.addMenuItem(this.statusItem);

        // Separador + submenú de novedades (historial de cambios de estado)
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._historySubMenu = new PopupMenu.PopupSubMenuMenuItem('Novedades (0)');
        this.menu.addMenuItem(this._historySubMenu);
        this._rebuildHistoryMenu();

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
            this._anyProblem = false;

            // Primer chequeo inmediato — _updateIcons() se reprograma solo al
            // terminar cada vez (ver _scheduleNextUpdate), así que no hace
            // falta llamar aparte aquí.
            this._updateIcons();

            this._settingsHandler = this._settings.connect(
                'changed::refresh-interval',
                () => this._scheduleNextUpdate()
            );
            this._settingsHandlerFast = this._settings.connect(
                'changed::refresh-interval-unstable',
                () => this._scheduleNextUpdate()
            );

            // Ajustes que solo cambian cómo se muestra lo que ya se midió
            // (no qué pinguear) — se aplican al toque con los datos ya
            // guardados, sin esperar el próximo ciclo (que puede ser hasta
            // 60s si así lo configuraste para no recargar la red).
            const cosmeticKeys = [
                'show-numeric-labels',
                'local-good-threshold', 'local-medium-threshold',
                'internet-good-threshold', 'internet-medium-threshold',
                'local-loss-threshold', 'local-jitter-threshold',
                'internet-loss-threshold', 'internet-jitter-threshold',
            ];
            this._cosmeticHandlers = cosmeticKeys.map(key =>
                this._settings.connect(`changed::${key}`, () => this._updateIconsAndTooltip())
            );
    }

    // Cadencia adaptable: rápido mientras hay un problema detectado, tranquilo
    // cuando todo está bien — así el widget se siente "en tiempo real" justo
    // cuando importa, sin tener que elegir un solo intervalo de compromiso.
    // Como _updateIcons() vuelve a llamar a esta función recién al terminar
    // cada ciclo (no un timer fijo de fondo), nunca se superponen dos ráfagas
    // aunque una tarde más de lo normal por una conexión mala.
    _scheduleNextUpdate() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        const normal = Math.max(1, this._settings.get_int('refresh-interval'));
        const fast = Math.max(1, this._settings.get_int('refresh-interval-unstable'));
        const interval = this._anyProblem ? Math.min(fast, normal) : normal;

        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._updateIcons();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    // Registra una novedad: la escribe en el journal del sistema (con el
    // nivel correspondiente, para poder filtrar con "journalctl -p warning")
    // y la guarda en el historial en memoria que alimenta el submenú
    // "Novedades". El journal ya rota y limpia solo (systemd-journald), no
    // hace falta logrotate/rsyslog aparte.
    _logEvent(level, message) {
        const line = `[ping-indicator] ${message}`;
        if (level === 'error') console.error(line);
        else if (level === 'warning') console.warn(line);
        else console.log(line);

        const time = new Date().toLocaleTimeString('es-EC', {hour: '2-digit', minute: '2-digit', second: '2-digit'});
        this._history.push({time, level, message});
        if (this._history.length > this._maxHistory) {
            this._history.shift();
        }
        this._rebuildHistoryMenu();
    }

    // Compara el estado anterior contra el nuevo para "Router" o "Internet"
    // y decide si hay que registrar algo y con qué severidad:
    //   - Se pierde la conexión del todo               -> error
    //   - El semáforo empeora, o se vuelve inestable    -> warning
    //   - El semáforo mejora, o se estabiliza           -> info
    _logTransitions(label, prevTier, newTier, prevUnstable, newUnstable, stats) {
        const sinConexion = !stats || stats.avg < 0 || stats.loss >= 100;

        if (prevTier !== null && prevTier !== newTier) {
            if (sinConexion) {
                this._logEvent('error', `${label}: sin conexión`);
            } else if (TIER_RANK[newTier] > TIER_RANK[prevTier]) {
                this._logEvent('warning', `${label} pasó a estado ${TIER_LABEL[newTier]}`);
            } else {
                this._logEvent('info', `${label} se recuperó a estado ${TIER_LABEL[newTier]}`);
            }
        }

        if (prevUnstable !== newUnstable) {
            if (newUnstable) {
                this._logEvent('warning', `${label} detectado inestable (pérdida ${stats.loss}%, jitter ${stats.mdev.toFixed(1)}ms)`);
            } else {
                this._logEvent('info', `${label} se estabilizó`);
            }
        }
    }

    // Redibuja el submenú "Novedades" a partir de this._history (la más
    // reciente arriba). Se llama cada vez que se agrega una entrada nueva;
    // como los cambios de estado no son constantes, reconstruir todo el
    // submenú en cada log es barato y mucho más simple que ir actualizando
    // items existentes uno por uno.
    _rebuildHistoryMenu() {
        this._historySubMenu.menu.removeAll();
        this._historySubMenu.label.text = `Novedades (${this._history.length})`;

        const copyItem = new PopupMenu.PopupMenuItem('Copiar comando para ver el log completo');
        copyItem.connect('activate', () => {
            const cmd = 'journalctl --user _COMM=gnome-shell -p warning -b 0';
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, cmd);
            Main.notify('Ping Indicator', 'Comando copiado al portapapeles');
        });
        this._historySubMenu.menu.addMenuItem(copyItem);
        this._historySubMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (this._history.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('Sin novedades todavía');
            empty.actor.reactive = false;
            this._historySubMenu.menu.addMenuItem(empty);
            return;
        }

        for (const entry of this._history.slice().reverse()) {
            const icon = LEVEL_ICON[entry.level] || 'ℹ';
            const item = new PopupMenu.PopupMenuItem(`${icon} ${entry.time} — ${entry.message}`);
            item.actor.reactive = false;
            item.label.clutter_text.set_line_wrap(true);
            this._historySubMenu.menu.addMenuItem(item);
        }
    }

    async _getDefaultGateway() {
        try {
            const output = await runCommandAsync(['ip', 'route', 'show', 'default']);
            if (!output) return null;
            const match = output.match(/default via (\d+\.\d+\.\d+\.\d+)/);
            return match ? match[1] : null;
        } catch (e) {
            console.error(`Error obteniendo gateway: ${e}`);
            return null;
        }
    }

    async _updateIcons() {
        const gatewayAddress = this._settings.get_string('gateway-address');
        const internetAddress = this._settings.get_string('internet-address');
        const pingCount = Math.max(1, this._settings.get_int('ping-count'));

        if (!gatewayAddress || gatewayAddress === '') {
            if (!this.gateway) {
                this.gateway = await this._getDefaultGateway();
            }
        } else {
            this.gateway = gatewayAddress;
        }

        const [localStats, internetStats] = await Promise.all([
            this.gateway ? pingBurst(this.gateway, pingCount) : Promise.resolve(null),
            pingBurst(internetAddress || 'google.com', pingCount),
        ]);

        this._lastLocalStats = localStats;
        this._lastInternetStats = internetStats;
        this._lastUpdate = new Date();

        this._updateIconsAndTooltip();
        this._maybeRunMtr(internetAddress || 'google.com');
        this._scheduleNextUpdate();
    }

    _maybeRunMtr(host) {
        if (!this._settings.get_boolean('mtr-enabled')) return;
        if (!this._mtrAvailable || this._mtrRunning) return;

        const tier = latencyTier(
            this._lastInternetStats,
            this._settings.get_int('internet-good-threshold'),
            this._settings.get_int('internet-medium-threshold')
        );
        const unstable = isUnstable(
            this._lastInternetStats,
            this._settings.get_int('internet-loss-threshold'),
            this._settings.get_int('internet-jitter-threshold')
        );
        if (tier !== 'bad' && !unstable) return;

        const cooldown = this._settings.get_int('mtr-cooldown');
        const now = GLib.get_monotonic_time() / 1000000;
        if (now - this._lastMtrTime < cooldown) return;

        this._lastMtrTime = now;
        this._mtrRunning = true;

        // 20s de margen: mtr con -c 6 -i 1 tarda ~6-7s en el caso normal,
        // pero saltos con DNS lento o mucha pérdida pueden estirarlo bastante.
        runCommandAsync(['mtr', '-r', '-w', '-b', '-z', '-c', '6', '-i', '1', host], 20).then(output => {
            this._mtrRunning = false;
            if (output === null) {
                // mtr no instalado o falló: no seguir intentando cada ciclo.
                this._mtrAvailable = false;
                return;
            }
            const hops = parseMtrHops(output);
            const worst = findWorstHop(hops);
            if (worst && (worst.loss > 0 || worst.stdev >= this._settings.get_int('internet-jitter-threshold'))) {
                this._lastMtrSummary = `${worst.host} — ${worst.loss}% pérdida, jitter ${worst.stdev.toFixed(1)}ms (prom ${worst.avg.toFixed(1)}ms)`;
                // Pérdida alta en el salto responsable = probable corte real,
                // no solo lentitud puntual -> error en vez de warning.
                const level = worst.loss >= 50 ? 'error' : 'warning';
                this._logEvent(level, `Diagnóstico mtr — ${this._lastMtrSummary}`);
            } else {
                this._lastMtrSummary = 'sin salto responsable identificado en esta pasada (puede ser muy intermitente)';
                this._logEvent('warning', `Diagnóstico mtr — ${this._lastMtrSummary}`);
            }
            this._updateIconsAndTooltip();
        });
    }

    _statLine(label, stats, unstable) {
        if (!stats || stats.avg < 0) {
            return `${label}: Sin conexión`;
        }
        const flag = unstable ? ' ⚠ inestable' : '';
        return `${label}: ${stats.avg.toFixed(1)} ms · pérdida ${stats.loss}% · jitter ${stats.mdev.toFixed(1)}ms${flag}`;
    }

    _updateIconsAndTooltip() {
        // Obtener umbrales de configuración
        const localGood = this._settings.get_int('local-good-threshold');
        const localMedium = this._settings.get_int('local-medium-threshold');
        const internetGood = this._settings.get_int('internet-good-threshold');
        const internetMedium = this._settings.get_int('internet-medium-threshold');
        const localLoss = this._settings.get_int('local-loss-threshold');
        const localJitter = this._settings.get_int('local-jitter-threshold');
        const internetLoss = this._settings.get_int('internet-loss-threshold');
        const internetJitter = this._settings.get_int('internet-jitter-threshold');

        // El semáforo (tier) y la insignia de inestabilidad son 2 señales
        // independientes ahora — ver Opción A del comparativo de íconos.
        const localTier = latencyTier(this._lastLocalStats, localGood, localMedium);
        const internetTier = latencyTier(this._lastInternetStats, internetGood, internetMedium);
        this._localUnstable = isUnstable(this._lastLocalStats, localLoss, localJitter);
        this._internetUnstable = isUnstable(this._lastInternetStats, internetLoss, internetJitter);

        // Registrar en el log/historial cualquier cambio de estado respecto
        // a la medición anterior, antes de sobreescribir el "prev".
        this._logTransitions('Router', this._prevLocalTier, localTier, this._prevLocalUnstable, this._localUnstable, this._lastLocalStats);
        this._logTransitions('Internet', this._prevInternetTier, internetTier, this._prevInternetUnstable, this._internetUnstable, this._lastInternetStats);
        this._prevLocalTier = localTier;
        this._prevInternetTier = internetTier;
        this._prevLocalUnstable = this._localUnstable;
        this._prevInternetUnstable = this._internetUnstable;

        // Usado por _scheduleNextUpdate() para acelerar la cadencia mientras
        // esto siga así.
        this._anyProblem = localTier === 'bad' || internetTier === 'bad'
            || this._localUnstable || this._internetUnstable;

        let tooltipText = this._statLine('Router', this._lastLocalStats, this._localUnstable) + ` (${TIER_LABEL[localTier]})\n`;
        tooltipText += this._statLine('Internet', this._lastInternetStats, this._internetUnstable) + ` (${TIER_LABEL[internetTier]})`;

        if ((this._internetUnstable || internetTier === 'bad') && this._lastMtrSummary) {
            tooltipText += `\n\nDiagnóstico automático (mtr):\n${this._lastMtrSummary}`;
        } else if (this._mtrRunning) {
            tooltipText += `\n\nCorriendo diagnóstico mtr en segundo plano...`;
        }

        // Aplicar iconos: el color/forma viene del semáforo; la insignia de
        // inestabilidad viene horneada en un segundo SVG por tier
        // (local-good-unstable.svg, etc.) — un solo ícono plano, sin capas de
        // Clutter superpuestas en tiempo real (ver nota en el repo sobre por
        // qué se descartó esa vía).
        try {
            const localSuffix = this._localUnstable ? '-unstable' : '';
            const internetSuffix = this._internetUnstable ? '-unstable' : '';
            this.localIcon.set_gicon(
                Gio.icon_new_for_string(`${this._extensionPath}/icons/local-${localTier}${localSuffix}.svg`)
            );
            this.internetIcon.set_gicon(
                Gio.icon_new_for_string(`${this._extensionPath}/icons/internet-${internetTier}${internetSuffix}.svg`)
            );
        } catch (e) {
            console.error(`Error cargando iconos: ${e}`);
        }

        // Número de latencia junto al ícono, igual que CPU/batería en el panel.
        const showLabels = this._settings.get_boolean('show-numeric-labels');
        this.localLabel.visible = showLabels;
        this.internetLabel.visible = showLabels;
        if (showLabels) {
            this.localLabel.text = this._formatMs(this._lastLocalStats);
            this.internetLabel.text = this._formatMs(this._lastInternetStats);
        }

        this.setTooltipText(tooltipText);
        this.statusItem.label.text = tooltipText;
    }

    _formatMs(stats) {
        if (!stats || stats.avg < 0) return '--';
        return stats.avg < 10 ? `${stats.avg.toFixed(1)}ms` : `${Math.round(stats.avg)}ms`;
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
        let tooltipText = `Última actualización: hace ${elapsed} segundos\n`;
        tooltipText += this._statLine('Router', this._lastLocalStats, this._localUnstable) + '\n';
        tooltipText += this._statLine('Internet', this._lastInternetStats, this._internetUnstable);
        if (this._lastMtrSummary) {
            tooltipText += `\n\nÚltimo diagnóstico mtr:\n${this._lastMtrSummary}`;
        }

        this.setTooltipText(tooltipText);
    }

    stop() {
        if (this._settingsHandler) {
            this._settings.disconnect(this._settingsHandler);
            this._settingsHandler = null;
        }
        if (this._settingsHandlerFast) {
            this._settings.disconnect(this._settingsHandlerFast);
            this._settingsHandlerFast = null;
        }
        if (this._cosmeticHandlers) {
            this._cosmeticHandlers.forEach(id => this._settings.disconnect(id));
            this._cosmeticHandlers = null;
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
