// MNLI-tuned model, quantized ONNX weights (see the Task 1 report for size and timings).
export const MODEL_ID = 'Xenova/nli-deberta-v3-xsmall';

export type ZeroShotResult = { labels: string[]; scores: number[] };

type Classifier = (text: string, labels: string[]) => Promise<ZeroShotResult>;

let classifier: Promise<Classifier> | undefined;

async function build(): Promise<Classifier> {
  // Imported lazily so routes that never classify don't pay for loading onnxruntime.
  const { env, pipeline } = await import('@huggingface/transformers');
  // Vercel's filesystem is read-only except /tmp.
  if (process.env.VERCEL) env.cacheDir = '/tmp/transformers-cache';
  env.allowLocalModels = false;
  return (await pipeline('zero-shot-classification', MODEL_ID, { dtype: 'q8' })) as unknown as Classifier;
}

function load(): Promise<Classifier> {
  if (!classifier) {
    const p = build();
    // A failed load must not be cached: the next call retries.
    p.catch(() => {
      if (classifier === p) classifier = undefined;
    });
    classifier = p;
  }
  return classifier;
}

/** Scores `text` against `labels`. Labels come back sorted by score, descending. */
export async function zeroShot(text: string, labels: string[]): Promise<ZeroShotResult> {
  const run = await load();
  const out = await run(text, labels);
  return { labels: out.labels, scores: out.scores };
}
