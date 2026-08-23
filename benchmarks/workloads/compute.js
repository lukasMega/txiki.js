import { SEED, mulberry32, timed } from './prng.js';

// Pure-JS CPU work: the QuickJS interpreter itself. Should be flat across every profile --
// none of the slim levers touch the engine. A move here means a compiler/optimisation flag
// change (MinSizeRel, -Oz, LTO), which is precisely what makes it worth measuring.

const MANDEL_DIM = 320;
const MANDEL_ITER = 100;

timed('mandelbrot', MANDEL_DIM * MANDEL_DIM, () => {
    let inside = 0;

    for (let py = 0; py < MANDEL_DIM; py++) {
        const y0 = ((py / MANDEL_DIM) * 2) - 1;

        for (let px = 0; px < MANDEL_DIM; px++) {
            const x0 = ((px / MANDEL_DIM) * 3) - 2;
            let x = 0;
            let y = 0;
            let i = 0;

            while ((x * x) + (y * y) <= 4 && i < MANDEL_ITER) {
                const xt = (x * x) - (y * y) + x0;

                y = (2 * x * y) + y0;
                x = xt;
                i++;
            }

            if (i === MANDEL_ITER) {
                inside++;
            }
        }
    }

    return inside;
});

const SORT_N = 200000;
const rand = mulberry32(SEED);
const nums = new Array(SORT_N);

for (let i = 0; i < SORT_N; i++) {
    nums[i] = rand();
}

timed('sort', SORT_N, () => {
    const copy = nums.slice();

    copy.sort((a, b) => a - b);

    return copy[0];
});

const STRING_N = 60000;

timed('string-build', STRING_N, () => {
    const parts = [];

    for (let i = 0; i < STRING_N; i++) {
        parts.push(`item-${i}-${(i * 2654435761) % 97}`);
    }

    return parts.join(',').length;
});
