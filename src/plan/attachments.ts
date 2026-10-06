import { realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { DougsError, ExitCode } from '../output/errors.js';

/** File types Dougs accepts as justifying documents, and the only ones a plan may upload. */
export const UPLOAD_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.heic', '.webp']);

export interface UploadPolicy {
  /** Directory relative paths resolve against (the plan file's directory). */
  baseDir: string;
  cwd: string;
  /** Allow files outside baseDir and cwd (explicit opt-in: --allow-any-path). */
  allowAnyPath?: boolean;
}

function unsafe(message: string, hint?: string): DougsError {
  return new DougsError('UNSAFE_ATTACHMENT', message, { exitCode: ExitCode.usage, hint });
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * Resolve an attach step's file to the real absolute path that will be uploaded.
 * A plan can come from an agent or a shared file, so it may only upload receipt
 * file types, and only from the plan's directory or the working directory
 * (symlinks resolved), unless the user explicitly allows any path.
 */
export function resolveUpload(file: string, policy: UploadPolicy): string {
  const candidate = isAbsolute(file) ? file : resolve(policy.baseDir, file);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new DougsError('FILE_NOT_FOUND', `File to attach not found: ${candidate}`, {
      exitCode: ExitCode.usage,
    });
  }
  if (!statSync(real).isFile()) throw unsafe(`Not a regular file: ${real}`);
  if (!UPLOAD_EXTENSIONS.has(extname(real).toLowerCase()))
    throw unsafe(
      `Refusing to upload ${real}: only ${[...UPLOAD_EXTENSIONS].join(', ')} files can be attached`,
    );
  if (
    !policy.allowAnyPath &&
    !isInside(real, realDir(policy.baseDir)) &&
    !isInside(real, realDir(policy.cwd))
  )
    throw unsafe(
      `Refusing to upload ${real}: it is outside the plan's directory and the current directory`,
      'move the file next to the plan, or re-run with --allow-any-path if you trust this plan',
    );
  return real;
}
