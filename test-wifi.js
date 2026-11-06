#!/usr/bin/env gjs
// Prueba la lógica Wi-Fi (wifi-logic.js) y la lectura real de NetworkManager
// (wifi.js) SIN GNOME Shell. Correr con: gjs -m test-wifi.js
//
// La parte 2 SOLO LEE (foto de red, puntos de acceso, BSSID fijado). Nunca
// llama a pin(), así que no toca ningún perfil de conexión.

import GLib from 'gi://GLib';
import {bandOf, channelOf, sameNetworkSwitch, groupByNetwork, detectFlapping, shouldReleasePin, classifySwitch, isPinWeak} from './wifi-logic.js';
import {WifiWatcher} from './wifi.js';

function assert(condition, label) {
    print(`${condition ? 'OK  ' : 'FAIL'} — ${label}`);
    if (!condition) imports.system.exit(1);
}

print('== 1. Lógica pura ==');
assert(bandOf(2412) === '2.4 GHz' && bandOf(5180) === '5 GHz' && bandOf(5955) === '6 GHz', 'bandOf');
assert(channelOf(2412) === 1 && channelOf(2462) === 11 && channelOf(5180) === 36 && channelOf(5220) === 44, 'channelOf');

const a = {ssid: 'CASA', bssid: 'AA:01', strength: 60};
const b = {ssid: 'CASA', bssid: 'BB:02', strength: 42};
const otra = {ssid: 'VECINO', bssid: 'CC:03', strength: 20};
assert(sameNetworkSwitch(a, b), 'salto entre 2 APs de la misma red cuenta');
assert(!sameNetworkSwitch(a, a), 'mismo AP no cuenta');
assert(!sameNetworkSwitch(a, otra), 'cambiar de red no cuenta como rebote');
assert(!sameNetworkSwitch(null, a), 'sin punto anterior no cuenta');

const groups = groupByNetwork([b, otra, a, {ssid: '', bssid: 'DD:04', strength: 99}]);
assert(groups.length === 2, 'las redes ocultas se omiten');
assert(groups[0].ssid === 'CASA' && groups[0].aps[0].bssid === 'AA:01', 'grupos y APs ordenados por señal');

const ev = t => ({time: t});
assert(!detectFlapping([ev(100)], 150, 2, 300).flapping, '1 salto no es rebote (umbral 2)');
assert(detectFlapping([ev(100), ev(136)], 150, 2, 300).flapping, '2 saltos en 36 s sí es rebote');
assert(!detectFlapping([ev(100), ev(136)], 500, 2, 300).flapping, 'saltos fuera de la ventana no cuentan');
assert(detectFlapping([ev(100), ev(136)], 500, 2, 300).recent.length === 0, 'devuelve solo los recientes');

// Soltar el punto fijo: solo desconectado Y con el punto fijo fuera de vista/sin señal.
const visibles = [{bssid: 'BB:02', strength: 42}];
assert(shouldReleasePin({pinned: 'aa:01', aps: visibles, connected: false}, 15), 'desconectado y el fijo no se ve -> soltar');
assert(shouldReleasePin({pinned: 'AA:01', aps: [{bssid: 'AA:01', strength: 8}], connected: false}, 15), 'desconectado y el fijo casi sin señal -> soltar');
assert(!shouldReleasePin({pinned: 'AA:01', aps: [{bssid: 'aa:01', strength: 60}], connected: false}, 15), 'desconectado pero el fijo sigue al alcance -> no soltar');
assert(!shouldReleasePin({pinned: 'AA:01', aps: visibles, connected: true}, 15), 'conectado nunca se suelta');
assert(!shouldReleasePin({pinned: null, aps: visibles, connected: false}, 15), 'sin punto fijo no hay nada que soltar');

// Escenario real: fijo un punto, suspendo, despierto junto al OTRO punto y el fijo
// ya no se alcanza. NetworkManager puede seguir listándolo como "visible" (lista
// desactualizada tras suspender), así que no basta mirar la lista: pasadas varias
// revisiones seguidas sin conectar se suelta siempre.
{
    const stale = [{bssid: 'AA:01', strength: 60}, {bssid: 'BB:02', strength: 70}];   // el fijo AA:01 sigue "visible"
    assert(!shouldReleasePin({pinned: 'AA:01', aps: stale, connected: false, checks: 1}, 15), '1ª revisión: el fijo figura visible y fuerte -> todavía no se suelta');
    assert(shouldReleasePin({pinned: 'AA:01', aps: stale, connected: false, checks: 2}, 15), '2ª revisión sin conectar: se suelta aunque la lista diga que se ve');
    assert(!shouldReleasePin({pinned: 'AA:01', aps: stale, connected: true, checks: 5}, 15), 'conectado nunca se suelta, sin importar las revisiones');
    assert(shouldReleasePin({pinned: 'AA:01', aps: stale, connected: false, checks: 3}, 15, 3), 'forceAfter configurable');
    assert(!shouldReleasePin({pinned: 'AA:01', aps: stale, connected: false, checks: 2}, 15, 3), 'antes de forceAfter, solo cuenta la lista');
}

// Conectado al punto fijo pero con mala señal, y otro de la misma red se ve mucho mejor.
{
    const aps = [
        {ssid: 'CASA', bssid: 'AA:01', strength: 22},     // el fijo, lejos
        {ssid: 'CASA', bssid: 'BB:02', strength: 70},     // el otro, cerca
        {ssid: 'OTRA', bssid: 'CC:03', strength: 99},     // otra red: no cuenta
    ];
    assert(isPinWeak({pinned: 'aa:01', aps}, 30, 25), 'fijo débil (22%) y otro de la misma red mucho mejor (70%) -> débil');
    assert(!isPinWeak({pinned: 'AA:01', aps: [{ssid: 'CASA', bssid: 'AA:01', strength: 22}]}, 30, 25), 'sin otro punto mejor que ofrecer no se suelta');
    assert(!isPinWeak({pinned: 'AA:01', aps: [{ssid: 'CASA', bssid: 'AA:01', strength: 55}, {ssid: 'CASA', bssid: 'BB:02', strength: 90}]}, 30, 25), 'fijo con señal aceptable (55%) no es débil aunque haya uno mejor');
    assert(!isPinWeak({pinned: 'AA:01', aps: [{ssid: 'CASA', bssid: 'AA:01', strength: 22}, {ssid: 'CASA', bssid: 'BB:02', strength: 40}]}, 30, 25), 'el otro no es lo bastante mejor (margen 25) -> no cambiar por poco');
    assert(!isPinWeak({pinned: 'AA:01', aps: [{ssid: 'OTRA', bssid: 'CC:03', strength: 99}]}, 30, 25), 'si el fijo ni se ve, no es este caso');
    assert(!isPinWeak({pinned: null, aps}, 30, 25), 'sin punto fijo no hay nada que soltar');
}

// Cambios provocados por la propia extensión (fijar/soltar) no cuentan como salto.
assert(classifySwitch(a, b, 100, 0) === 'roam', 'sin ventana abierta, el cambio es un salto espontáneo');
assert(classifySwitch(a, b, 100, 130) === 'self', 'dentro de la ventana abierta al fijar -> self');
assert(classifySwitch(a, b, 131, 130) === 'roam', 'pasada la ventana vuelve a contar como salto');
assert(classifySwitch(a, otra, 100, 130) === null, 'cambiar de red no es salto, ni siquiera con ventana');
assert(classifySwitch(null, a, 100, 130) === null, 'sin punto anterior no hay salto');
{
    // El escenario del problema: fijar A -> B y volver a B -> A en pocos minutos.
    const events = [];
    let suppressUntil = 0;
    const pin = t => { suppressUntil = t + 30; };                 // la extensión abre la ventana al fijar
    const apChanged = (from, to, t) => {                           // llega el cambio de AP
        const kind = classifySwitch(from, to, t, suppressUntil);
        if (kind === 'self') suppressUntil = 0;
        if (kind === 'roam') events.push({time: t});
    };
    pin(10);  apChanged(a, b, 14);    // fijo B
    pin(60);  apChanged(b, a, 65);    // pruebo y vuelvo a A
    assert(!detectFlapping(events, 70, 2, 300).flapping, 'dos fijaciones seguidas NO encienden el rebote');
    apChanged(a, b, 100); apChanged(b, a, 130);   // dos saltos espontáneos de verdad
    assert(detectFlapping(events, 140, 2, 300).flapping, 'los saltos espontáneos posteriores sí cuentan (la ventana se cerró)');
}

print('== 2. Lectura real de NetworkManager (solo lectura) ==');
const loop = GLib.MainLoop.new(null, false);
const watcher = new WifiWatcher(e => print(`   salto detectado: ${e.from.bssid} -> ${e.to.bssid}`));
watcher.start();

GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
    const snap = watcher.snapshot();
    if (!snap) {
        print('SKIP — sin adaptador Wi-Fi');
    } else {
        print(`   red: ${snap.ssid} | conexión: ${snap.connectionId} | BSSID fijado: ${snap.pinned ?? '(automático)'}`);
        for (const g of groupByNetwork(snap.aps).slice(0, 5)) {
            print(`   ${g.ssid}: ${g.aps.length} punto(s)`);
            for (const ap of g.aps) {
                print(`      ${ap.active ? '●' : '○'} ${ap.band} c${ap.channel} ${ap.strength}% ${ap.bssid}`);
            }
        }
        assert(snap.aps.length > 0, 'lista puntos de acceso visibles');
        assert(snap.ssid === null || snap.aps.some(ap => ap.active), 'el punto de acceso activo aparece en la lista');

        // Para poder conectarse desde el menú (solo lectura: no se conecta a nada).
        assert(snap.aps.every(ap => typeof ap.path === 'string' && ap.path.startsWith('/org/freedesktop/NetworkManager/AccessPoint/')),
            'cada punto de acceso trae su ruta D-Bus (hace falta para conectar)');
        assert(snap.aps.every(ap => typeof ap.secured === 'boolean'), 'cada punto de acceso indica si es protegido');
        const saved = new Set(), unsaved = new Set();
        for (const g of groupByNetwork(snap.aps)) (watcher.savedProfileFor(g.ssid) ? saved : unsaved).add(`${g.ssid}${g.aps[0].secured ? ' 🔒' : ''}`);
        print(`   con perfil guardado: ${[...saved].join(', ') || '(ninguna)'}`);
        print(`   sin perfil (pedirían contraseña si es protegida): ${[...unsaved].slice(0, 5).join(', ')}${unsaved.size > 5 ? ', …' : ''}`);
        if (snap.ssid) assert(watcher.savedProfileFor(snap.ssid) !== null, 'savedProfileFor encuentra el perfil de la red actual');
        assert(watcher.savedProfileFor('__red_que_no_existe__') === null, 'savedProfileFor devuelve null si no hay perfil');
        print(`   hasPin: ${watcher.hasPin()} | isDisconnected: ${watcher.isDisconnected()} | isPinWeak: ${watcher.isPinWeak(30, 25)}`);
        assert(watcher.isDisconnected() === (snap.ssid === null), 'isDisconnected coincide con la foto');
    }
    watcher.stop();
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
print('Listo.');
