// Lógica de red pura, sin nada de GNOME Shell (St/Main/PanelMenu) — se puede
// probar con `gjs test-netcheck.js` directo en una terminal, sin recargar
// la extensión ni cerrar sesión. extension.js importa estas mismas funciones.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

// Ejecuta un comando de forma asíncrona (no bloquea GNOME Shell) y devuelve su stdout.
export async function runCommandAsync(argv) {
    try {
        const proc = new Gio.Subprocess({
            argv,
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
        });
        proc.init(null);
        const [stdout] = await proc.communicate_utf8_async(null, null);
        return stdout;
    } catch (e) {
        console.error(`Error ejecutando ${argv.join(' ')}: ${e}`);
        return null;
    }
}

// Corre una ráfaga de pings y devuelve pérdida/latencia/jitter, en vez de un solo dato suelto.
export async function pingBurst(host, count) {
    const output = await runCommandAsync(['ping', '-c', String(count), '-i', '0.2', '-W', '1', host]);
    if (!output) return null;

    const lossMatch = output.match(/(\d+)% packet loss/);
    const loss = lossMatch ? parseFloat(lossMatch[1]) : 100;

    const rttMatch = output.match(/= ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/);
    if (!rttMatch) {
        // Sin línea de rtt: no llegó ninguna respuesta útil.
        return {loss, avg: -1, min: -1, max: -1, mdev: 0};
    }

    return {
        loss,
        min: parseFloat(rttMatch[1]),
        avg: parseFloat(rttMatch[2]),
        max: parseFloat(rttMatch[3]),
        mdev: parseFloat(rttMatch[4]),
    };
}

// Parsea el reporte de `mtr` y ubica el salto con más pérdida/variación (excluyendo el propio equipo).
export function parseMtrHops(text) {
    const hops = [];
    for (const line of text.split('\n')) {
        const m = line.match(/^\s*(\d+)\.\s*(?:AS\S*\s+)?(.*?)\s+([\d.]+)%\s+(\d+)\s+([\d.]+|\?+)\s+([\d.]+|\?+)\s+([\d.]+|\?+)\s+([\d.]+|\?+)\s+([\d.]+|\?+)\s*$/);
        if (!m) continue;
        hops.push({
            hop: parseInt(m[1], 10),
            host: m[2].trim(),
            loss: parseFloat(m[3]),
            avg: parseFloat(m[6]) || 0,
            worst: parseFloat(m[8]) || 0,
            stdev: parseFloat(m[9]) || 0,
        });
    }
    return hops;
}

export function findWorstHop(hops) {
    const candidates = hops.filter(h => h.hop > 1 && h.host !== '???');
    if (candidates.length === 0) return null;
    return candidates.reduce((worst, h) => {
        if (h.loss > worst.loss) return h;
        if (h.loss === worst.loss && h.stdev > worst.stdev) return h;
        return worst;
    });
}

// Nivel por latencia promedio — good/medium/bad, el semáforo de siempre.
export function latencyTier(stats, goodT, mediumT) {
    if (!stats || stats.avg < 0 || stats.loss >= 100) return 'bad';
    if (stats.avg < goodT) return 'good';
    if (stats.avg < mediumT) return 'medium';
    return 'bad';
}

// Señal independiente del semáforo: hay pérdida o jitter alto aunque el
// promedio se vea bien. En la UI esto se muestra como una insignia aparte,
// no como un color más del semáforo (ver Opción A del comparativo de íconos).
export function isUnstable(stats, lossT, jitterT) {
    if (!stats) return false;
    return stats.loss >= lossT || stats.mdev >= jitterT;
}
