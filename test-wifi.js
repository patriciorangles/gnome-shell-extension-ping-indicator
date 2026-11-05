#!/usr/bin/env gjs
// Prueba la lógica Wi-Fi (wifi-logic.js) y la lectura real de NetworkManager
// (wifi.js) SIN GNOME Shell. Correr con: gjs -m test-wifi.js
//
// La parte 2 SOLO LEE (foto de red, puntos de acceso, BSSID fijado). Nunca
// llama a pin(), así que no toca ningún perfil de conexión.

import GLib from 'gi://GLib';
import {bandOf, channelOf, sameNetworkSwitch, groupByNetwork, detectFlapping, shouldReleasePin} from './wifi-logic.js';
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
    }
    watcher.stop();
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
print('Listo.');
