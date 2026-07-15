import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';

import JSZip from 'jszip';

function rewriteAudioRefs(value, replacements) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteAudioRefs(item, replacements));
  }
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === 'audioRef' && typeof item === 'string' && replacements.has(item)
        ? replacements.get(item)
        : rewriteAudioRefs(item, replacements),
    ]),
  );
}

function runFfmpeg(inputPath, outputPath) {
  const result = spawnSync(
    process.env.FFMPEG_PATH || 'ffmpeg',
    ['-y', '-v', 'error', '-i', inputPath, '-ac', '1', '-b:a', '64k', outputPath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed for ${basename(inputPath)}: ${result.stderr || result.error}`);
  }
}

async function prepareFeaturedDemoCourse(inputPath, outputPath, coverPath) {
  const source = await JSZip.loadAsync(await readFile(inputPath));
  const manifestFile = source.file('manifest.json');
  if (!manifestFile) throw new Error('Source classroom is missing manifest.json');
  const manifest = JSON.parse(await manifestFile.async('text'));
  if (!manifest.stage || !Array.isArray(manifest.scenes) || !manifest.mediaIndex) {
    throw new Error('Source classroom manifest is incomplete');
  }

  const output = new JSZip();
  const workDir = await mkdtemp(join(tmpdir(), 'spiralmaic-featured-demo-'));
  const audioReplacements = new Map();
  const oldAudioPaths = new Set(
    Object.entries(manifest.mediaIndex)
      .filter(([, entry]) => entry.type === 'audio' && !entry.missing)
      .map(([path]) => path),
  );

  try {
    for (const [path, entry] of Object.entries(source.files)) {
      if (entry.dir || path === 'manifest.json' || oldAudioPaths.has(path)) continue;
      output.file(path, await entry.async('nodebuffer'));
    }

    const nextMediaIndex = {};
    let audioCount = 0;
    for (const [path, entry] of Object.entries(manifest.mediaIndex)) {
      if (entry.type !== 'audio' || entry.missing) {
        nextMediaIndex[path] = entry;
        continue;
      }

      const sourceEntry = source.file(path);
      if (!sourceEntry) throw new Error(`Missing source audio: ${path}`);
      const stem = basename(path, extname(path));
      const inputAudio = join(workDir, `${stem}.wav`);
      const outputAudio = join(workDir, `${stem}.mp3`);
      await writeFile(inputAudio, await sourceEntry.async('nodebuffer'));
      runFfmpeg(inputAudio, outputAudio);
      const mp3 = await readFile(outputAudio);
      const nextPath = path.replace(/\.[^/.]+$/, '.mp3');
      output.file(nextPath, mp3, { compression: 'STORE' });
      audioReplacements.set(path, nextPath);
      nextMediaIndex[nextPath] = {
        ...entry,
        mimeType: 'audio/mpeg',
        format: 'mp3',
        size: mp3.byteLength,
      };
      audioCount += 1;
    }

    manifest.mediaIndex = nextMediaIndex;
    manifest.scenes = rewriteAudioRefs(manifest.scenes, audioReplacements);

    for (const path of Object.keys(manifest.mediaIndex)) {
      if (!output.file(path)) throw new Error(`Output is missing manifest media: ${path}`);
    }

    output.file('manifest.json', JSON.stringify(manifest));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      await output.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      }),
    );

    const coverEntry = Object.entries(manifest.mediaIndex).find(
      ([, entry]) =>
        (entry.type === 'generated' || entry.type === 'image') &&
        entry.mimeType === 'image/png' &&
        !entry.missing,
    );
    if (!coverEntry) throw new Error('Source classroom has no PNG image for the demo cover');
    const sourceCover = source.file(coverEntry[0]);
    if (!sourceCover) throw new Error(`Missing cover source: ${coverEntry[0]}`);
    await mkdir(dirname(coverPath), { recursive: true });
    await writeFile(coverPath, await sourceCover.async('nodebuffer'));

    const outputBytes = (await readFile(outputPath)).byteLength;
    process.stdout.write(
      `Prepared ${manifest.stage.name}: ${manifest.scenes.length} scenes, ${audioCount} MP3 files, ${(outputBytes / 1024 / 1024).toFixed(1)} MB\n`,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const positionalArgs = process.argv.slice(2).filter((argument) => argument !== '--');
const [inputPath, outputPath, coverPath] = positionalArgs;
if (!inputPath || !outputPath || !coverPath) {
  process.stderr.write(
    'Usage: node scripts/prepare-featured-demo-course.mjs <input.maic.zip> <output.maic.zip> <cover.png>\n',
  );
  process.exitCode = 1;
} else {
  await prepareFeaturedDemoCourse(inputPath, outputPath, coverPath);
}
