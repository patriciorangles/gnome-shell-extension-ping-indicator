#!/usr/bin/env gjs
// Prueba la lógica de red (netcheck.js) SIN GNOME Shell — nada de recargar
// extensión ni cerrar sesión. Correr con: gjs test-netcheck.js
//
// Esto es justo lo que hubiera detectado el bug de communicate_utf8_async
// en segundos, en vez de tener que cerrar sesión para descubrirlo.

import GLib from 'gi://GLib';
import {pingBurst, parseMtrHops, findWorstHop, latencyTier, isUnstable} from './netcheck.js';

// gjs standalone no mantiene vivo el proceso para I/O async por su cuenta
// (a diferencia de dentro de GNOME Shell, que ya tiene su propio bucle
// corriendo) — sin este mainloop explícito, el script termina antes de que
// el subproceso de `ping` alcance a responder.
const loop = GLib.MainLoop.new(null, false);

function assert(condition, label) {
    print(`${condition ? 'OK  ' : 'FAIL'} — ${label}`);
    if (!condition) imports.system.exit(1);
}

async function main() {
    print('== 1. pingBurst() contra el gateway (127.0.0.1 como fallback si no hay red) ==');
    const stats = await pingBurst('127.0.0.1', 3);
    print(JSON.stringify(stats));
    assert(stats !== null, 'pingBurst no debe devolver null en localhost');
    assert(stats.avg >= 0, 'debe haber promedio de latencia');
    assert(stats.loss === 0, 'localhost no debería perder paquetes');

    print('\n== 2. pingBurst() contra un host que no existe (debe fallar limpio, no tirar excepción) ==');
    const deadStats = await pingBurst('192.0.2.1', 2); // TEST-NET-1, no debería responder
    print(JSON.stringify(deadStats));
    assert(deadStats !== null, 'incluso sin respuesta debe devolver un objeto, no null');
    assert(deadStats.loss === 100, 'debe reportar 100% de pérdida');

    print('\n== 3. latencyTier() + isUnstable() — ahora son 2 señales independientes ==');
    assert(latencyTier({avg: 10, loss: 0, mdev: 1}, 50, 100) === 'good', 'promedio bajo -> good');
    assert(!isUnstable({avg: 10, loss: 0, mdev: 1}, 20, 30), 'sin pérdida ni jitter -> estable');
    assert(latencyTier({avg: 10, loss: 40, mdev: 1}, 50, 100) === 'good', 'el semáforo sigue siendo good por promedio...');
    assert(isUnstable({avg: 10, loss: 40, mdev: 1}, 20, 30), '...pero la insignia de inestable se prende aparte (el caso que motivó todo esto)');
    assert(latencyTier({avg: 200, loss: 0, mdev: 1}, 50, 100) === 'bad', 'promedio muy alto -> bad');
    assert(!isUnstable({avg: 200, loss: 0, mdev: 1}, 20, 30), 'bad por promedio no implica inestable si no hay pérdida/jitter');
    assert(latencyTier(null, 50, 100) === 'bad', 'sin datos -> bad');
    assert(!isUnstable(null, 20, 30), 'sin datos -> no marcar inestable (ya se ve "bad" en el semáforo)');

    print('\n== 4. parseMtrHops() + findWorstHop() con un reporte de ejemplo ==');
    const sample = `Start: 2026-09-09T17:04:24-0500
HOST: patomasterhpdeb             Loss%   Snt   Last   Avg  Best  Wrst StDev
  1. AS???    _gateway (192.168.18.1)  0.0%    30    1.3   1.6   0.9   5.0   1.0
  2. AS???    ???                     100.0%    30    0.0   0.0   0.0   0.0   0.0
  3. AS???    192.168.177.213          0.0%    30    6.8   4.2   3.4   7.9   1.2
  4. AS???    cloudflare-uio.nap.ec (200.1.6.26)  20.0%    30    3.6   5.2   3.6  17.7   3.3
  5. AS13335  one.one.one.one (1.1.1.1) 0.0%     30    3.5   3.5   2.8   5.8   0.7`;
    const hops = parseMtrHops(sample);
    print(`Saltos parseados: ${hops.length}`);
    assert(hops.length === 5, 'debe parsear las 5 líneas de saltos');
    const worst = findWorstHop(hops);
    print(`Peor salto: ${JSON.stringify(worst)}`);
    assert(worst.host.includes('cloudflare-uio.nap.ec'), 'debe identificar el salto con 20% de pérdida, no el gateway (hop 1)');

    print('\nTodo pasó ✅');
}

main()
    .catch(e => {
        printerr(`Error: ${e}`);
        imports.system.exit(1);
    })
    .finally(() => loop.quit());

loop.run();
