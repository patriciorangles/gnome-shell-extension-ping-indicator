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

import {runCommandAsync, pingBurst, parseMtrHops, findWorstHop, latencyTier, isUnstable, isOutage, confirmationsFor, StateDebouncer} from './netcheck.js';
import {detectFlapping, groupByNetwork, sameDevice, deviceNumbers} from './wifi-logic.js';
// wifi.js (la parte que habla con NetworkManager) se carga aparte y con
// try/catch en _startWifi(): si algo falla ahí, el ping sigue funcionando.

// Señal (%) por debajo de la cual el punto de acceso fijo se considera "perdido".
const PIN_RELEASE_MIN_STRENGTH = 15;

// Punto fijo "débil": con conexión pero señal por debajo de PIN_WEAK_BELOW (%)
// mientras otro punto de la misma red se ve al menos PIN_WEAK_MARGIN puntos mejor,
// de forma sostenida durante PIN_WEAK_SECONDS. Típico al moverte hacia el otro
// equipo con la laptop abierta.
const PIN_WEAK_BELOW = 30;
const PIN_WEAK_MARGIN = 25;
const PIN_WEAK_SECONDS = 20;

// Destino de internet cuando el ajuste está vacío. Una IP y no un nombre: con
// "google.com" cada ping dependía del DNS, y un DNS lento colgaba la ráfaga
// (hubo cientos de "no respondió, se forzó a terminar" por hora).
const DEFAULT_INTERNET_HOST = '8.8.8.8';

// Segundos que dura la vista previa de la insignia ("Probar ícono").
const PREVIEW_SECONDS = 8;

// Orden de severidad de cada tier, para saber si un cambio es una mejora o
// un empeoramiento (y decidir el nivel del log: info al mejorar, warning al
// empeorar). 'down' (corte total) solo existe para el historial/journal: el
// ícono sigue usando good/medium/bad.
const TIER_RANK = {good: 0, medium: 1, bad: 2, down: 3};
const TIER_LABEL = {good: 'Excelente', medium: 'Aceptable', bad: 'Crítico', down: 'Sin conexión'};
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

        // Se pone en true la primera vez que tocamos un widget ya destruido
        // (típicamente porque gnome-shell lo destruyó al reconstruir la UI
        // tras un congelamiento de GPU, sin pasar por nuestro disable()).
        // Una vez detectado, cortamos el ciclo de actualización en vez de
        // seguir lanzando la misma excepción sin parar — eso fue lo que
        // generó más de 4 millones de líneas de log en 9 días (ver
        // project_ping_indicator_bugs.md, Bug 1).
        this._disposed = false;

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
        // Cuántas mediciones seguidas hacen falta para anotar un cambio de
        // estado se lee de los ajustes en cada medición (se aplica al instante).
        this._localTierDebounce = new StateDebouncer(3, (to, from) => this._tierConfirmations(to, from));
        this._internetTierDebounce = new StateDebouncer(3, (to, from) => this._tierConfirmations(to, from));
        this._localUnstableDebounce = new StateDebouncer(3, () => this._stateConfirmations());
        this._internetUnstableDebounce = new StateDebouncer(3, () => this._stateConfirmations());

        // Wi-Fi: saltos entre puntos de acceso con el mismo nombre (ver wifi.js).
        // this._roamEvents guarda solo los saltos dentro de la ventana de
        // detección; this._wifiFlapping es true mientras haya "rebote".
        this._wifi = null;
        this._roamEvents = [];
        this._wifiFlapping = false;
        this._wifiFlapCount = 0;
        // Vista previa de la insignia (opción "Probar ícono" del submenú Wi-Fi):
        // la muestra unos segundos sin tocar el estado real de rebote.
        this._badgePreview = false;
        this._badgePreviewId = 0;
        // Reglas que sueltan solas el punto fijo cuando deja de servir.
        this._lostChecks = 0;          // revisiones seguidas desconectado con punto fijo
        this._pinWeakSince = 0;        // desde cuándo el punto fijo es "débil" (s, monotónico)
        this._sleepSubId = 0;          // suscripción a PrepareForSleep (logind)
        this._resumeTimerId = 0;

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

        // Insignia que solo aparece mientras la laptop salta entre puntos de
        // acceso de la misma red (ver _updateWifiBadge).
        this.roamIcon = new St.Icon({
            icon_size: 18,
            style_class: 'system-status-icon',
            visible: false
        });
        this.roamIcon.set_gicon(
            Gio.icon_new_for_string(`${this._extensionPath}/icons/wifi-roaming.svg`)
        );

        this.box.add_child(this.localGroup);
        this.box.add_child(this.internetGroup);
        this.box.add_child(this.roamIcon);
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

        // Submenú Wi-Fi: puntos de acceso visibles, y fijar uno o dejar en
        // automático. Se reconstruye cada vez que se abre el menú (la señal y
        // las redes visibles cambian constantemente, no vale la pena mantenerlo
        // al día en segundo plano). Oculto hasta que el monitoreo arranque.
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._wifiSubMenu = new PopupMenu.PopupSubMenuMenuItem('Wi-Fi');
        this._wifiSubMenu.visible = false;
        this.menu.addMenuItem(this._wifiSubMenu);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) this._rebuildWifiMenu();
        });

        // Separador + submenú de novedades (historial de cambios de estado)
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._historySubMenu = new PopupMenu.PopupSubMenuMenuItem('Novedades (0)');
        this.menu.addMenuItem(this._historySubMenu);
        this._rebuildHistoryMenu();

            // Detección real de "widget destruido externamente" (p.ej. por
            // gnome-shell reconstruyendo la UI tras un congelamiento de GPU,
            // sin pasar por nuestro disable()). Esto NO se puede detectar con
            // try/catch: asignar una propiedad a un St.Widget ya destruido no
            // lanza excepción, solo registra una advertencia en el log y no
            // hace nada — por eso el intento anterior (capturar excepciones)
            // nunca se activaba y el log se seguía llenando. La señal
            // 'destroy' de GObject sí es confiable: se dispara siempre que el
            // objeto muere, lo haya matado quien lo haya matado.
            for (const widget of [this, this.localIcon, this.internetIcon,
                this.localLabel, this.internetLabel, this.statusItem, this._historySubMenu,
                this.roamIcon, this._wifiSubMenu]) {
                widget.connect('destroy', () => this._onDisposedWidget('destroy signal'));
            }

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
                'roam-flap-threshold', 'roam-flap-window',
            ];
            this._cosmeticHandlers = cosmeticKeys.map(key =>
                this._settings.connect(`changed::${key}`, () => this._updateIconsAndTooltip())
            );

            // Monitoreo de saltos entre puntos de acceso Wi-Fi: se puede
            // apagar/encender desde las preferencias sin reiniciar nada.
            this._wifiHandler = this._settings.connect(
                'changed::wifi-watch-enabled',
                () => this._startWifi()
            );
            this._startWifi();
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
                // Esta fuente se elimina sola al devolver SOURCE_REMOVE: hay que
                // soltar el ID guardado. Si no, el siguiente _scheduleNextUpdate()
                // intenta source_remove() de un ID que ya no existe y GLib registra
                // "Source ID N was not found" en cada ciclo (cientos por hora).
                this._timeoutId = null;
                this._updateIcons();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    // Mediciones seguidas que confirman un cambio de estado antes de que llegue
    // a "Novedades" y al journal. El ícono sigue cambiando en tiempo real; esto
    // solo evita llenar el historial cuando una métrica oscila alrededor de un
    // umbral (llegó a haber 104 avisos Excelente ↔ Aceptable por hora).
    _stateConfirmations() {
        return Math.max(1, this._settings.get_int('state-confirmations'));
    }

    // Igual, pero para el semáforo, donde el corte total ('down') se trata aparte:
    //  - entrar en corte: pocas ráfagas (una sola podría ser un microcorte de ~1 s);
    //  - salir del corte: la primera ráfaga que responde ya es la recuperación y
    //    no tiene por qué anotarse con 10-15 s de retraso;
    //  - cualquier otro cambio (vaivén de umbral): state-confirmations.
    _tierConfirmations(to, from) {
        return confirmationsFor(to, from, {
            state: this._settings.get_int('state-confirmations'),
            enter: this._settings.get_int('outage-enter-confirmations'),
            leave: this._settings.get_int('outage-leave-confirmations'),
        });
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
    //
    // tierChange / unstableChange son {previous, current} ya CONFIRMADOS por un
    // StateDebouncer (varias mediciones seguidas), o null si no hubo cambio.
    _logTransitions(label, tierChange, unstableChange, stats) {
        if (tierChange) {
            const prevTier = tierChange.previous;
            const newTier = tierChange.current;
            if (newTier === 'down') {
                this._logEvent('error', `${label}: sin conexión`);
            } else if (prevTier === 'down' && newTier === 'bad') {
                // Respondió otra vez, pero con latencia crítica: no es una recuperación plena.
                this._logEvent('warning', `${label} volvió a responder, pero en estado ${TIER_LABEL[newTier]}`);
            } else if (TIER_RANK[newTier] > TIER_RANK[prevTier]) {
                this._logEvent('warning', `${label} pasó a estado ${TIER_LABEL[newTier]}`);
            } else {
                this._logEvent('info', `${label} se recuperó a estado ${TIER_LABEL[newTier]}`);
            }
        }

        if (unstableChange) {
            if (unstableChange.current) {
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
        if (this._disposed) return;
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
        if (this._disposed) return;
        const gatewayAddress = this._settings.get_string('gateway-address');
        const internetAddress = this._settings.get_string('internet-address');
        const pingCount = Math.max(1, this._settings.get_int('ping-count'));

        if (!gatewayAddress || gatewayAddress === '') {
            // Se consulta en CADA ciclo (es un `ip route` instantáneo): al
            // cambiar de red (Wi-Fi ↔ hotspot del celular, VPN, cable) el
            // gateway cambia. Antes se guardaba la primera vez y no se volvía
            // a leer, así que tras el cambio seguía haciendo ping al gateway
            // de la red anterior y el router salía "sin conexión" (--)
            // aunque internet funcionara, hasta volver a la red original.
            this.gateway = await this._getDefaultGateway();
        } else {
            this.gateway = gatewayAddress;
        }

        const [localStats, internetStats] = await Promise.all([
            this.gateway ? pingBurst(this.gateway, pingCount) : Promise.resolve(null),
            pingBurst(internetAddress || DEFAULT_INTERNET_HOST, pingCount),
        ]);

        this._lastLocalStats = localStats;
        this._lastInternetStats = internetStats;
        this._lastUpdate = new Date();

        try {
            this._updateIconsAndTooltip();
            this._maybeRunMtr(internetAddress || DEFAULT_INTERNET_HOST);
            this._maybeReleaseWeakPin();
        } catch (e) {
            this._onDisposedWidget(e);
            return;
        }
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
            if (this._disposed) return;
            if (output === null) {
                // mtr no instalado o falló: no seguir intentando cada ciclo.
                this._mtrAvailable = false;
                return;
            }
            try {
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
            } catch (e) {
                this._onDisposedWidget(e);
            }
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

        // Se revisa también en cada ciclo para que la insignia de Wi-Fi se
        // apague sola cuando los saltos salen de la ventana de detección.
        this._updateWifiBadge();

        // Registrar en el log/historial cualquier cambio de estado respecto
        // a la medición anterior, antes de sobreescribir el "prev".
        this._logTransitions('Router',
            this._localTierDebounce.update(isOutage(this._lastLocalStats) ? 'down' : localTier),
            this._localUnstableDebounce.update(this._localUnstable),
            this._lastLocalStats);
        this._logTransitions('Internet',
            this._internetTierDebounce.update(isOutage(this._lastInternetStats) ? 'down' : internetTier),
            this._internetUnstableDebounce.update(this._internetUnstable),
            this._lastInternetStats);

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
        tooltipText += this._wifiTooltipLine();

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
                if (this._disposed) return GLib.SOURCE_REMOVE;
                try {
                    this._updateDynamicTooltip();
                } catch (e) {
                    this._onDisposedWidget(e);
                    return GLib.SOURCE_REMOVE;
                }
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
        tooltipText += this._wifiTooltipLine();

        this.setTooltipText(tooltipText);
    }

    // ------------------------------------------------------------------
    // Wi-Fi: saltos entre puntos de acceso de la misma red
    // ------------------------------------------------------------------

    async _startWifi() {
        if (this._disposed) return;
        if (!this._settings.get_boolean('wifi-watch-enabled')) {
            this._stopWifi();
            return;
        }
        if (this._wifi) return;
        try {
            const {WifiWatcher} = await import('./wifi.js');
            if (this._disposed || this._wifi) return;
            this._wifi = new WifiWatcher(
                ev => this._onRoam(ev),
                () => this._onWifiLost(),
                ev => this._onSelfSwitch(ev));
            this._wifi.start();
            this._subscribeSleep();
            this._wifiSubMenu.visible = true;
        } catch (e) {
            console.error(`[ping-indicator] Wi-Fi: no se pudo iniciar el monitoreo de puntos de acceso: ${e}`);
        }
    }

    // Apagado desde las preferencias: además de soltar el watcher, esconde la
    // insignia y el submenú. (stop() usa solo _stopWifiWatcher: al cerrar no se
    // deben tocar widgets que quizá ya estén destruidos.)
    _stopWifi() {
        this._stopWifiWatcher();
        this._roamEvents = [];
        this._wifiFlapping = false;
        if (this._disposed) return;
        this.roamIcon.visible = false;
        this._wifiSubMenu.visible = false;
    }

    _stopWifiWatcher() {
        this._unsubscribeSleep();
        if (this._resumeTimerId) {
            GLib.source_remove(this._resumeTimerId);
            this._resumeTimerId = 0;
        }
        if (this._wifi) {
            this._wifi.stop();
            this._wifi = null;
        }
    }

    // ------------------------------------------------------------------
    // El punto fijo no debe sobrevivir a una suspensión
    // ------------------------------------------------------------------
    // Escenario real: fijo un punto, cierro la laptop, me muevo junto al OTRO
    // punto, la abro: el perfil sigue limitado al punto de antes (ahora lejos) y
    // no hay conexión estable. Un punto fijo es una ayuda para la sesión, no una
    // decisión permanente: se suelta al suspender.

    _subscribeSleep() {
        if (this._sleepSubId) return;
        this._sleepSubId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1', 'org.freedesktop.login1.Manager', 'PrepareForSleep',
            '/org/freedesktop/login1', null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [sleeping] = params.deep_unpack();
                if (sleeping) this._onGoingToSleep();
                else this._onResumed();
            });
    }

    _unsubscribeSleep() {
        if (this._sleepSubId) {
            Gio.DBus.system.signal_unsubscribe(this._sleepSubId);
            this._sleepSubId = 0;
        }
    }

    // Antes de suspender: solo se guarda el cambio en el perfil (sin reconectar);
    // al despertar NetworkManager ya conecta con el perfil en automático, al
    // mejor punto de donde estés, sin una reconexión extra.
    _onGoingToSleep() {
        if (this._disposed || !this._wifi) return;
        if (!this._settings.get_boolean('pin-release-on-sleep') || !this._wifi.hasPin()) return;
        this._wifi.releasePin(false, (released, error) => {
            if (this._disposed) return;
            if (error) {
                this._logEvent('error', `Wi-Fi: no se pudo soltar el punto fijo antes de suspender: ${error.message ?? error}`);
            } else if (released) {
                this._logEvent('info', 'Wi-Fi: punto de acceso fijo soltado antes de suspender (al volver puedes estar en otro lugar)');
            }
        });
    }

    // Red de seguridad: si al despertar el perfil sigue con punto fijo (no se
    // alcanzó a guardar el cambio al suspender), se suelta y se reconecta.
    _onResumed() {
        if (this._disposed || !this._wifi || this._resumeTimerId) return;
        if (!this._settings.get_boolean('pin-release-on-sleep')) return;
        this._resumeTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._resumeTimerId = 0;
            if (this._disposed || !this._wifi || !this._wifi.hasPin()) return GLib.SOURCE_REMOVE;
            this._wifi.releasePin(true, (released, error) => {
                if (this._disposed) return;
                if (error) {
                    this._logEvent('error', `Wi-Fi: no se pudo soltar el punto fijo al reanudar: ${error.message ?? error}`);
                } else if (released) {
                    this._logEvent('warning', 'Wi-Fi: punto de acceso fijo soltado al reanudar (podías estar en otro lugar)');
                    Main.notify('Ping Indicator', 'Se soltó el punto de acceso fijo al reanudar: Wi-Fi en modo automático');
                }
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    // Conectado al punto fijo pero con mala señal, habiendo otro de la misma red
    // mucho mejor de forma sostenida: el fijo ya no sirve. Se evalúa en cada ciclo.
    _maybeReleaseWeakPin() {
        if (this._disposed || !this._wifi) return;
        if (!this._settings.get_boolean('pin-auto-release') ||
            !this._wifi.isPinWeak(PIN_WEAK_BELOW, PIN_WEAK_MARGIN)) {
            this._pinWeakSince = 0;
            return;
        }
        const now = GLib.get_monotonic_time() / 1000000;
        if (!this._pinWeakSince) {
            this._pinWeakSince = now;
            return;
        }
        if (now - this._pinWeakSince < PIN_WEAK_SECONDS) return;

        this._pinWeakSince = 0;
        this._wifi.releasePin(true, (released, error) => {
            if (this._disposed) return;
            if (error) {
                this._logEvent('error', `Wi-Fi: no se pudo soltar el punto fijo débil: ${error.message ?? error}`);
            } else if (released) {
                this._logEvent('warning', 'Wi-Fi: el punto de acceso fijo tiene señal débil y hay otro mucho mejor, se volvió a modo automático');
                Main.notify('Ping Indicator', 'El punto de acceso fijo tiene señal débil: Wi-Fi vuelve a modo automático');
            }
        });
    }

    // ev = {time, ssid, from, to}: un salto entre dos puntos de acceso de la
    // misma red. Cada salto queda en el historial/journal; que haya "rebote"
    // (varios seguidos) lo decide _updateWifiBadge con los umbrales de ajustes.
    _onRoam(ev) {
        if (this._disposed) return;
        this._roamEvents.push(ev);
        const desc = ap => `${ap.band} canal ${ap.channel} (${ap.bssid.slice(-5)})`;
        // Dos bandas del MISMO equipo (2.4 ↔ 5 GHz) o dos equipos distintos
        // (router + repetidor): el arreglo no es el mismo, por eso se distingue.
        const kind = sameDevice(ev.from.bssid, ev.to.bssid)
            ? 'cambió de banda en el mismo equipo'
            : 'cambió de equipo';
        this._logEvent('info', `Wi-Fi "${ev.ssid}": ${kind}, ${desc(ev.from)} → ${desc(ev.to)}`);
        try {
            this._updateWifiBadge();
        } catch (e) {
            this._onDisposedWidget(e);
        }
    }

    // El cambio de punto de acceso lo provocó la propia extensión (fijar o
    // soltar un punto desde el menú, o la liberación automática). Se anota en
    // el historial para que se entienda, pero NO cuenta para el rebote.
    _onSelfSwitch(ev) {
        if (this._disposed) return;
        const desc = ap => `${ap.band} canal ${ap.channel} (${ap.bssid.slice(-5)})`;
        this._logEvent('info', `Wi-Fi "${ev.ssid}": reconectado a ${desc(ev.to)} (cambio hecho desde el indicador, no cuenta como salto)`);
    }

    // El Wi-Fi se quedó sin punto de acceso. Si hay un punto fijo y sigue sin
    // conexión, se revisa cada `pin-release-delay` segundos MIENTRAS dure la
    // desconexión (antes era una sola revisión: si en ese momento la lista de
    // puntos aún mostraba el fijo como "visible", jamás se volvía a mirar). La
    // 1ª revisión suelta el fijo si ya no está a la vista; desde la 2ª, siempre
    // (ver shouldReleasePin). Un solo temporizador a la vez: se detiene solo al
    // reconectar, al soltar el fijo o al desactivar la opción.
    _onWifiLost() {
        if (this._disposed || this._wifiLostTimerId) return;
        if (!this._settings.get_boolean('pin-auto-release')) return;

        this._lostChecks = 0;
        const delay = Math.max(5, this._settings.get_int('pin-release-delay'));
        this._wifiLostTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            if (this._disposed || !this._wifi || !this._wifi.isDisconnected() || !this._wifi.hasPin()) {
                this._wifiLostTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._lostChecks++;
            this._wifi.releasePinIfLost(PIN_RELEASE_MIN_STRENGTH, this._lostChecks, (released, error) => {
                if (this._disposed) return;
                if (error) {
                    this._logEvent('error', `Wi-Fi: no se pudo soltar el punto de acceso fijo: ${error.message ?? error}`);
                } else if (released) {
                    this._logEvent('warning', 'Wi-Fi: sin conexión con el punto de acceso fijo, se volvió a modo automático');
                    Main.notify('Ping Indicator', 'El punto de acceso fijo no está al alcance: Wi-Fi vuelve a modo automático');
                }
            });
            // Si se soltó, hasPin() ya es false (el perfil se limpia al instante).
            if (this._wifi.hasPin()) return GLib.SOURCE_CONTINUE;
            this._wifiLostTimerId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateWifiBadge() {
        if (this._disposed) return;
        const now = GLib.get_monotonic_time() / 1000000;
        const threshold = Math.max(2, this._settings.get_int('roam-flap-threshold'));
        const windowSec = Math.max(30, this._settings.get_int('roam-flap-window'));
        const result = detectFlapping(this._roamEvents, now, threshold, windowSec);

        // Los saltos viejos (fuera de la ventana) ya no sirven para nada.
        this._roamEvents = result.recent;
        this._wifiFlapCount = result.count;

        if (result.flapping !== this._wifiFlapping) {
            this._wifiFlapping = result.flapping;
            if (result.flapping) {
                this._logEvent('warning', `Wi-Fi: saltando entre puntos de acceso (${result.count} cambios en ${Math.round(windowSec / 60)} min). Puedes fijar uno desde el menú → Wi-Fi.`);
            } else {
                this._logEvent('info', 'Wi-Fi: dejó de saltar entre puntos de acceso');
            }
        }
        this.roamIcon.visible = this._wifiFlapping || this._badgePreview;
    }

    // Muestra la insignia de rebote unos segundos, solo para ver cómo luce y
    // dónde queda en el panel: no registra eventos ni cambia el estado real.
    _previewBadge() {
        if (this._disposed) return;
        if (this._badgePreviewId) {
            GLib.source_remove(this._badgePreviewId);
            this._badgePreviewId = 0;
        }
        this._badgePreview = true;
        this.roamIcon.visible = true;
        this._badgePreviewId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PREVIEW_SECONDS, () => {
            this._badgePreviewId = 0;
            this._badgePreview = false;
            if (!this._disposed) {
                try {
                    this._updateWifiBadge();
                } catch (e) {
                    this._onDisposedWidget(e);
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _wifiTooltipLine() {
        if (!this._wifiFlapping) return '';
        return `\n\n⚠ Wi-Fi: saltando entre puntos de acceso (${this._wifiFlapCount} cambios recientes). Menú → Wi-Fi para fijar uno.`;
    }

    _rebuildWifiMenu() {
        if (this._disposed || !this._wifi) return;
        const menu = this._wifiSubMenu.menu;
        menu.removeAll();

        const addInfo = text => {
            const item = new PopupMenu.PopupMenuItem(text);
            item.actor.reactive = false;
            item.label.clutter_text.set_line_wrap(true);
            menu.addMenuItem(item);
        };

        const snap = this._wifi.snapshot();
        if (!snap) {
            this._wifiSubMenu.label.text = 'Wi-Fi';
            addInfo('Sin adaptador Wi-Fi');
            return;
        }

        const groups = groupByNetwork(snap.aps);
        const mine = snap.ssid ? groups.find(g => g.ssid === snap.ssid) : null;
        const flag = this._wifiFlapping ? '⚠ ' : '';
        this._wifiSubMenu.label.text = snap.ssid ? `${flag}Wi-Fi: ${snap.ssid}` : 'Wi-Fi: sin conexión';

        if (mine) {
            const several = mine.aps.length > 1;
            // "Equipo N": los BSSID que comparten prefijo son bandas del mismo
            // equipo (ver wifi-logic.js), para distinguir un cambio de banda
            // de un cambio entre equipos distintos.
            const {numbers, count: deviceCount} = deviceNumbers(mine.aps);
            if (several) {
                addInfo(this._wifiFlapping
                    ? `⚠ Saltando entre puntos de acceso (${this._wifiFlapCount} cambios recientes)`
                    : `Esta red la emiten ${mine.aps.length} puntos de acceso (${deviceCount} equipo${deviceCount > 1 ? 's' : ''})`);
            }
            addInfo(snap.pinned
                ? `Modo: fijo en ${snap.pinned}` + (this._settings.get_boolean('pin-auto-release') || this._settings.get_boolean('pin-release-on-sleep')
                    ? ' (se suelta solo al suspender o si deja de servir)' : '')
                : 'Modo: automático (el sistema decide a qué punto conectarse)');
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            for (const ap of mine.aps) {
                let text = `${several ? `Equipo ${numbers.get(ap.bssid)} · ` : ''}${ap.band} · canal ${ap.channel} · ${ap.strength}% · ${ap.bssid}`;
                if (ap.active) text += ' — conectado';
                if (snap.pinned === ap.bssid) text += ' — fijo';
                const item = new PopupMenu.PopupMenuItem(text);
                item.setOrnament(ap.active ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
                if (several && snap.pinned !== ap.bssid) {
                    item.connect('activate', () => this._pinAp(ap.bssid));
                } else {
                    item.actor.reactive = false;
                }
                menu.addMenuItem(item);
            }
            if (several) {
                addInfo('Tocar un punto de acceso lo fija (se reconecta ahora).');
            }
            if (snap.pinned) {
                const auto = new PopupMenu.PopupMenuItem('Automático — permitir que el sistema cambie de punto');
                auto.connect('activate', () => this._pinAp(null));
                menu.addMenuItem(auto);
            }
        } else {
            addInfo('No estás conectado a una red Wi-Fi');
        }

        const others = groups.filter(g => g.ssid !== snap.ssid).slice(0, 12);
        if (others.length > 0) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            addInfo('Otras redes visibles (toca una para conectarte):');
            for (const g of others) {
                // 🔒 = protegida (pedirá contraseña si no está guardada).
                const lock = g.aps[0].secured ? '🔒 ' : '';
                const saved = this._wifi.savedProfileFor(g.ssid) ? ' · guardada' : '';
                const several = g.aps.length > 1 ? ` · ${g.aps.length} puntos de acceso` : '';
                const item = new PopupMenu.PopupMenuItem(`${lock}${g.ssid} — ${g.best}%${several}${saved}`);
                item.connect('activate', () => this._connectNetwork(g));
                menu.addMenuItem(item);
            }
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const preview = new PopupMenu.PopupMenuItem(`Probar ícono de rebote (${PREVIEW_SECONDS} s)`);
        preview.connect('activate', () => this._previewBadge());
        menu.addMenuItem(preview);
    }

    // Conecta a otra red de la lista. Se usa el punto de acceso de mejor señal
    // de esa red (groupByNetwork los deja ordenados). Si la red no está guardada
    // y es protegida, el agente de GNOME Shell pide la contraseña con su
    // diálogo de siempre.
    _connectNetwork(group) {
        if (!this._wifi) return;
        const target = group.aps[0];
        Main.notify('Ping Indicator', `Conectando a "${group.ssid}"…`);
        this._wifi.connectTo(group.ssid, target.path, (error, kind) => {
            if (this._disposed) return;
            if (error) {
                const reason = error.message ?? `${error}`;
                this._logEvent('error', `Wi-Fi: no se pudo conectar a "${group.ssid}": ${reason}`);
                Main.notify('Ping Indicator', `No se pudo conectar a "${group.ssid}": ${reason}`);
                return;
            }
            this._logEvent('info', `Wi-Fi: conectando a "${group.ssid}" (${target.band}, ${target.strength}%)${kind === 'new' ? ', red sin perfil guardado' : ''}`);
        });
    }

    // bssid = null vuelve a modo automático.
    _pinAp(bssid) {
        if (!this._wifi) return;
        this._wifi.pin(bssid, error => {
            if (this._disposed) return;
            if (error) {
                const reason = error.message ?? `${error}`;
                this._logEvent('error', `Wi-Fi: no se pudo ${bssid ? 'fijar' : 'liberar'} el punto de acceso: ${reason}`);
                Main.notify('Ping Indicator', `No se pudo cambiar el modo Wi-Fi: ${reason}`);
                return;
            }
            // El rebote se corta al fijar: la insignia no debe seguir
            // encendida hasta que expire la ventana.
            this._roamEvents = [];
            this._logEvent('info', bssid
                ? `Wi-Fi: fijado al punto de acceso ${bssid}`
                : 'Wi-Fi: modo automático restaurado');
            Main.notify('Ping Indicator', bssid
                ? `Wi-Fi fijado a ${bssid}. Reconectando…`
                : 'Wi-Fi en modo automático');
            try {
                this._updateWifiBadge();
                this._rebuildWifiMenu();
            } catch (e) {
                this._onDisposedWidget(e);
            }
        });
    }

    // Se llama la primera (y única) vez que una actualización choca con un
    // widget ya destruido. Registra el hecho UNA sola vez y corta todos los
    // temporizadores — sin esto, cada ciclo repite la misma excepción sin
    // parar hasta el próximo reinicio de gnome-shell.
    _onDisposedWidget(e) {
        if (this._disposed) return;
        this._disposed = true;
        console.error(`[ping-indicator] Widget destruido externamente, deteniendo actualizaciones: ${e}`);
        this.stop();
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
        if (this._wifiHandler) {
            this._settings.disconnect(this._wifiHandler);
            this._wifiHandler = null;
        }
        this._stopWifiWatcher();
        if (this._wifiLostTimerId) {
            GLib.source_remove(this._wifiLostTimerId);
            this._wifiLostTimerId = 0;
        }
        if (this._badgePreviewId) {
            GLib.source_remove(this._badgePreviewId);
            this._badgePreviewId = 0;
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
