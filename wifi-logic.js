// Lógica pura de Wi-Fi (sin GNOME Shell ni NetworkManager), para poder probarla
// con `gjs test-wifi.js` sin cerrar sesión. El lado que habla con NetworkManager
// está en wifi.js.

export function bandOf(freqMhz) {
    if (freqMhz >= 5925) return '6 GHz';
    if (freqMhz >= 4900) return '5 GHz';
    return '2.4 GHz';
}

export function channelOf(freqMhz) {
    if (freqMhz === 2484) return 14;
    if (freqMhz >= 2412 && freqMhz <= 2472) return (freqMhz - 2407) / 5;
    if (freqMhz >= 5955) return (freqMhz - 5950) / 5;
    if (freqMhz >= 4900 && freqMhz < 5925) return (freqMhz - 5000) / 5;
    return 0;
}

// Un "salto" solo cuenta si es entre dos puntos de acceso DISTINTOS de la
// MISMA red (mismo nombre). Pasar de una red a otra es un cambio normal, no un
// rebote.
export function sameNetworkSwitch(from, to) {
    return !!from && !!to && !!from.ssid && from.ssid === to.ssid && from.bssid !== to.bssid;
}

// Un equipo con varias bandas (2.4 y 5 GHz) emite un BSSID por banda, y casi
// siempre solo cambia el último byte (C4:FB:AA:E3:C8:28 y C4:FB:AA:E3:C8:2C).
// Heurística: mismos 5 primeros bytes = probablemente el mismo equipo. Sirve
// para distinguir "cambió de banda" de "cambió de equipo".
export function deviceKey(bssid) {
    return (bssid || '').toUpperCase().split(':').slice(0, 5).join(':');
}

export function sameDevice(bssidA, bssidB) {
    return !!bssidA && !!bssidB && deviceKey(bssidA) === deviceKey(bssidB);
}

// Numera los equipos distintos de una lista de puntos de acceso, en orden de
// aparición (la lista ya viene ordenada por señal): {bssid -> 1, 2, ...}.
export function deviceNumbers(aps) {
    const keys = [];
    const numbers = new Map();
    for (const ap of aps) {
        const key = deviceKey(ap.bssid);
        if (!keys.includes(key)) keys.push(key);
        numbers.set(ap.bssid, keys.indexOf(key) + 1);
    }
    return {numbers, count: keys.length};
}

// Agrupa los puntos de acceso visibles por nombre de red. Dentro de cada
// grupo, el de mejor señal primero; los grupos, de mejor a peor señal. Las
// redes ocultas (sin nombre) se omiten.
export function groupByNetwork(aps) {
    const map = new Map();
    for (const ap of aps) {
        if (!ap.ssid) continue;
        if (!map.has(ap.ssid)) map.set(ap.ssid, []);
        map.get(ap.ssid).push(ap);
    }
    const groups = [];
    for (const [ssid, list] of map) {
        list.sort((a, b) => b.strength - a.strength);
        groups.push({ssid, aps: list, best: list[0].strength});
    }
    groups.sort((a, b) => b.best - a.best);
    return groups;
}

// ¿Hay que soltar el punto de acceso fijo? Solo si estamos desconectados y el
// punto fijado ya no está a la vista (o su señal es casi nula): con el perfil
// limitado a ese BSSID, NetworkManager no se conectaría al otro punto de la
// misma red aunque lo tengas al lado. Estando conectado nunca se suelta.
export function shouldReleasePin({pinned, aps, connected}, minStrength) {
    if (!pinned || connected) return false;
    const target = pinned.toUpperCase();
    const ap = aps.find(a => a.bssid && a.bssid.toUpperCase() === target);
    return !ap || ap.strength <= minStrength;
}

// events: [{time (segundos, reloj monotónico), ...}] — solo saltos entre
// puntos de acceso de la misma red. Hay "rebote" cuando en la ventana hay al
// menos `threshold` saltos. Devuelve también los eventos recientes, para que
// quien llama pueda descartar los viejos.
export function detectFlapping(events, nowSec, threshold, windowSec) {
    const recent = events.filter(e => nowSec - e.time <= windowSec);
    return {flapping: recent.length >= threshold, count: recent.length, recent};
}
