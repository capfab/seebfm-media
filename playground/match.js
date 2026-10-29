// Typed commands: the visitor's sentence and the tested wordings embedded in the browser by the public
// all-MiniLM-L6-v2 (transformers.js, 8-bit, about 23 MB from Hugging Face, cached by the browser); the nearest wording by
// cosine similarity is played if it is at least THRESHOLD. Nothing typed leaves the browser.
const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1";
const MODEL = "Xenova/all-MiniLM-L6-v2";
// the threshold: at 0.58, 40 of 44 phrasings outside the tested wordings reach their own command and 2 a neighbouring
// walk, and 1 of 30 unrelated requests passes; the page always says what it understood
export const THRESHOLD = 0.58;

let ready = null;

export function load(wordings, onProgress = () => {}) {
  ready ??= (async () => {
    const { pipeline } = await import(LIB);
    const embed = await pipeline("feature-extraction", MODEL, { dtype: "q8", progress_callback: onProgress });
    const keys = Object.keys(wordings);
    const out = await embed(keys.map(k => wordings[k].text), { pooling: "mean", normalize: true });
    const dim = out.dims[1], data = out.data;
    return { embed, keys, dim, data };
  })();
  return ready;
}

export async function match(text, wordings) {
  const { embed, keys, dim, data } = await load(wordings);
  const q = (await embed([text], { pooling: "mean", normalize: true })).data;
  const scores = keys.map((k, i) => {
    let s = 0;
    for (let d = 0; d < dim; d++) s += q[d] * data[i * dim + d];
    return [k, s];
  }).sort((a, b) => b[1] - a[1]);
  const [key, score] = scores[0];
  return { key, score, ok: score >= THRESHOLD, top: scores.slice(0, 3) };
}
