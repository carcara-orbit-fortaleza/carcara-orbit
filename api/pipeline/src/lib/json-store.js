import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function readJson(filePath, fallback = undefined) {
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await rename(temporary, filePath);
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES') {
      await rm(filePath, { force: true });
      await rename(temporary, filePath);
    } else {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

export async function readJsonl(filePath, fallback = []) {
  try {
    const text = await readFile(filePath, 'utf8');
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonlAtomic(filePath, rows) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  await writeFile(temporary, body ? `${body}\n` : '', 'utf8');
  try {
    await rename(temporary, filePath);
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES') {
      await rm(filePath, { force: true });
      await rename(temporary, filePath);
    } else {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

export async function pathExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
