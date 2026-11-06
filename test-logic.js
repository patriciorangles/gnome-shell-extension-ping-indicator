#!/usr/bin/env gjs
// Prueba la lógica pura del indicador (sin red, sin GNOME Shell):
// StateDebouncer, findWorstHop/parseMtrHops y la identificación de equipos
// Wi-Fi. Correr con: gjs -m test-logic.js

import {parseMtrHops, findWorstHop, StateDebouncer, isOutage, confirmationsFor} from './netcheck.js';
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

print('== 1b. StateDebouncer con neededFor (corte total rápido, vaivén lento) ==');
{
    // La MISMA función que usa extension.js, con los valores por defecto del
    // esquema: entrar en 'down' = 2, salir de 'down' = 1, el resto = 3.
    const defaults = {state: 3, enter: 2, leave: 1};
    const rule = (to, from) => confirmationsFor(to, from, defaults);
    const d = new StateDebouncer(3, rule);
    d.update('good');                                              // estado inicial

    assert(d.update('down') === null, 'una sola ráfaga sin respuesta todavía no se anota (microcorte)');
    const down = d.update('down');
    assert(down && down.previous === 'good' && down.current === 'down', 'la 2ª ráfaga seguida confirma el corte (no 3)');

    const back = d.update('good');
    assert(back && back.previous === 'down' && back.current === 'good', 'la 1ª ráfaga buena ya anota la recuperación');

    // Un microcorte aislado no genera nada.
    const e = new StateDebouncer(3, rule);
    e.update('good'); e.update('down');
    assert(e.update('good') === null, 'microcorte de 1 ráfaga: ni "sin conexión" ni "recuperó"');

    // El vaivén de umbral sigue exigiendo 3.
    const f = new StateDebouncer(3, rule);
    f.update('good');
    assert(f.update('medium') === null && f.update('medium') === null, 'good -> medium todavía necesita 3');
    assert(f.update('medium') !== null, 'good -> medium se confirma con la 3ª');

    // Tras un corte, pasar a un estado distinto también sale rápido.
    const g = new StateDebouncer(3, rule);
    g.update('down');
    const out = g.update('bad');
    assert(out && out.previous === 'down' && out.current === 'bad', 'salir de down hacia bad también es inmediato');
}
print('== 1c. confirmationsFor (valores de los ajustes) ==');
{
    const cfg = {state: 3, enter: 2, leave: 1};
    assert(confirmationsFor('down', 'good', cfg) === 2, 'entrar en corte usa "enter"');
    assert(confirmationsFor('good', 'down', cfg) === 1, 'salir del corte usa "leave"');
    assert(confirmationsFor('medium', 'good', cfg) === 3, 'cambio de nivel usa "state"');
    assert(confirmationsFor('bad', 'down', cfg) === 1, 'down -> bad también usa "leave"');
    assert(confirmationsFor('down', 'down', {state: 3, enter: 5, leave: 4}) === 5, '"to" = down tiene prioridad');
    assert(confirmationsFor('down', 'good', {state: 0, enter: 0, leave: 0}) === 1, 'nunca menos de 1, aunque el ajuste sea 0');

    // Con 1 en todo, todo se anota al instante.
    const fast = {state: 1, enter: 1, leave: 1};
    const d = new StateDebouncer(3, (to, from) => confirmationsFor(to, from, fast));
    d.update('good');
    assert(d.update('down') !== null, 'enter = 1: el primer ráfaga sin respuesta ya se anota');
    assert(d.update('good') !== null, 'leave = 1: la primera que responde ya se anota');
    assert(d.update('medium') !== null, 'state = 1: un cambio de nivel se anota al instante');

    // Con valores altos, todo es más lento.
    const slow = {state: 5, enter: 4, leave: 3};
    const s = new StateDebouncer(3, (to, from) => confirmationsFor(to, from, slow));
    s.update('good');
    let n = 0;
    while (s.update('down') === null) n++;
    assert(n === 3, 'enter = 4: hacen falta 4 ráfagas seguidas (3 sin aviso + la 4ª que confirma)');
}
assert(isOutage(null), 'isOutage: sin medición = corte');
assert(isOutage({loss: 100, avg: -1}) && isOutage({loss: 100, avg: 5}) && isOutage({loss: 0, avg: -1}), 'isOutage: 100% de pérdida o sin rtt');
assert(!isOutage({loss: 40, avg: 80}) && !isOutage({loss: 0, avg: 3}), 'isOutage: pérdida parcial no es corte total');

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
