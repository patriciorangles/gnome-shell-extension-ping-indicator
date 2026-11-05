#!/usr/bin/env gjs
// Prueba la lógica pura del indicador (sin red, sin GNOME Shell):
// StateDebouncer, findWorstHop/parseMtrHops y la identificación de equipos
// Wi-Fi. Correr con: gjs -m test-logic.js

import {parseMtrHops, findWorstHop, StateDebouncer} from './netcheck.js';
import {deviceKey, sameDevice, deviceNumbers} from './wifi-logic.js';

function assert(condition, label) {
    print(`${condition ? 'OK  ' : 'FAIL'} — ${label}`);
    if (!condition) imports.system.exit(1);
}

print('== 1. StateDebouncer ==');
{
    const d = new StateDebouncer(3);
    assert(d.update('good') === null, 'la primera medición es el estado inicial, sin cambio');
    // Oscilación alrededor de un umbral (el caso real: 104 avisos por hora).
    let changes = 0;
    for (const v of ['medium', 'good', 'medium', 'good', 'medium', 'good']) {
        if (d.update(v)) changes++;
    }
    assert(changes === 0, 'oscilar cada ciclo no genera ningún cambio');

    assert(d.update('medium') === null && d.update('medium') === null, '2 mediciones seguidas todavía no confirman');
    const c = d.update('medium');
    assert(c && c.previous === 'good' && c.current === 'medium', '3 seguidas confirman good -> medium');
    assert(d.update('medium') === null, 'una vez confirmado, repetir no avisa de nuevo');

    // Un valor distinto en medio reinicia la cuenta.
    d.update('bad'); d.update('bad'); d.update('medium'); d.update('bad'); d.update('bad');
    const c2 = d.update('bad');
    assert(c2 && c2.current === 'bad', 'el conteo se reinicia si el valor se interrumpe');

    const b = new StateDebouncer(2);
    b.update(false);
    b.update(true);
    const cb = b.update(true);
    assert(cb && cb.previous === false && cb.current === true, 'funciona con booleanos (false es un estado válido)');
}

print('== 2. findWorstHop (pérdida efectiva) ==');
const mtr = rows => rows.map((r, i) =>
    `  ${i + 1}. AS???    ${r.host.padEnd(16)} ${r.loss.toFixed(1)}%   6   1.0   ${r.avg}   1.0   2.0   ${r.sd}`).join('\n');
{
    // Caso real de hoy: un salto con 83% de pérdida y los siguientes sin pérdida.
    const hops = parseMtrHops(mtr([
        {host: '192.168.18.1', loss: 0, avg: 1.5, sd: 0.4},
        {host: '172.16.179.161', loss: 83.3, avg: 189.0, sd: 0.0},
        {host: '200.1.2.3', loss: 0, avg: 25.0, sd: 3.0},
        {host: '8.8.8.8', loss: 0, avg: 28.0, sd: 1.0},
    ]));
    assert(hops.length === 4, 'parseMtrHops lee las 4 filas');
    const w = findWorstHop(hops);
    assert(w.loss === 0, 'el 83% intermedio que se recupera NO cuenta como pérdida real');
    assert(w.rawLoss === 0 || w.host !== '172.16.179.161', 'no se señala al salto que solo limita ICMP');
}
{
    // Corte real: desde el salto 3 todo se pierde.
    const w = findWorstHop(parseMtrHops(mtr([
        {host: '192.168.18.1', loss: 0, avg: 1.5, sd: 0.4},
        {host: '172.16.0.1', loss: 0, avg: 9.0, sd: 1.0},
        {host: '200.1.2.3', loss: 100, avg: 0, sd: 0},
        {host: '200.1.2.4', loss: 100, avg: 0, sd: 0},
        {host: '8.8.8.8', loss: 100, avg: 0, sd: 0},
    ])));
    assert(w.host === '200.1.2.3' && w.loss === 100, 'corte real: señala el PRIMER salto donde empieza la pérdida');
}
{
    // Pérdida parcial sostenida hasta el destino.
    const w = findWorstHop(parseMtrHops(mtr([
        {host: '192.168.18.1', loss: 0, avg: 1.5, sd: 0.4},
        {host: '172.16.0.1', loss: 30, avg: 9.0, sd: 1.0},
        {host: '200.1.2.3', loss: 40, avg: 20, sd: 2},
        {host: '8.8.8.8', loss: 30, avg: 28, sd: 1},
    ])));
    assert(w.host === '172.16.0.1' && w.loss === 30, 'pérdida sostenida: efectiva = mínimo hacia adelante (30%), en el primer salto');
}
{
    // Sin pérdida: gana el de mayor jitter.
    const w = findWorstHop(parseMtrHops(mtr([
        {host: '192.168.18.1', loss: 0, avg: 1.5, sd: 0.4},
        {host: '172.16.0.1', loss: 0, avg: 9.0, sd: 45.0},
        {host: '8.8.8.8', loss: 0, avg: 28, sd: 1},
    ])));
    assert(w.host === '172.16.0.1' && w.loss === 0, 'sin pérdida: se señala el de mayor jitter');
}

print('== 3. Equipos Wi-Fi (banda vs equipo) ==');
assert(deviceKey('c4:fb:aa:e3:c8:2c') === 'C4:FB:AA:E3:C8', 'deviceKey: 5 primeros bytes, en mayúsculas');
assert(sameDevice('C4:FB:AA:E3:C8:28', 'C4:FB:AA:E3:C8:2C'), '2.4 y 5 GHz del mismo equipo = mismo equipo');
assert(!sameDevice('C4:FB:AA:E3:B2:30', 'E8:4D:74:96:6A:AC'), 'equipos distintos');
assert(!sameDevice(null, 'C4:FB:AA:E3:C8:2C'), 'sin BSSID no hay coincidencia');
{
    const aps = [
        {bssid: 'E8:4D:74:96:6A:AC'}, {bssid: 'C4:FB:AA:E3:B2:30'},
        {bssid: 'E8:4D:74:96:6A:A8'}, {bssid: 'C4:FB:AA:E3:B2:2C'},
    ];
    const {numbers, count} = deviceNumbers(aps);
    assert(count === 2, 'deviceNumbers: 4 BSSID = 2 equipos');
    assert(numbers.get('E8:4D:74:96:6A:AC') === 1 && numbers.get('E8:4D:74:96:6A:A8') === 1, 'las dos bandas del primer equipo comparten número');
    assert(numbers.get('C4:FB:AA:E3:B2:30') === 2 && numbers.get('C4:FB:AA:E3:B2:2C') === 2, 'las dos bandas del segundo equipo comparten número');
}
print('Listo.');
