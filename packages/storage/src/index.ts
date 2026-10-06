import { config } from '@socialplay/config';
import { StorageProvider, FileType, STORAGE_BUCKETS, FILE_UPLOAD } from '@socialplay/shared';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface StorageFile {
  key: string;
  bucket: string;
  originalName: string;
  mimeType: string;
  size: number;
  etag: string;
  url: string;
  uploadedAt: Date;
}

export interface UploadOptions {
  bucket: string;
  key: string;
  file: Buffer | ReadableStream | AsyncIterable<Uint8Array>;
  mimeType: string;
  originalName: string;
  metadata?: Record<string, string>;
}

export interface DownloadOptions {
  bucket: string;
  key: string;
}

export interface DeleteOptions {
  bucket: string;
  key: string;
}

export interface PresignedUrlOptions {
  bucket: string;
  key: string;
  expiresIn?: number;
  method?: 'GET' | 'PUT';
}

export interface StorageProviderInterface {
  upload(options: UploadOptions): Promise<StorageFile>;
  download(options: DownloadOptions): Promise<ReadableStream<Uint8Array> | Buffer>;
  delete(options: DeleteOptions): Promise<void>;
  getPresignedUrl(options: PresignedUrlOptions): Promise<string>;
  fileExists(bucket: string, key: string): Promise<boolean>;
  getFileInfo(bucket: string, key: string): Promise<StorageFile | null>;
  listFiles(bucket: string, prefix?: string): Promise<StorageFile[]>;
}

class LocalStorageProvider implements StorageProviderInterface {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  private getFullPath(bucket: string, key: string): string {
    return path.join(this.basePath, bucket, key);
  }

  private async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async upload(options: UploadOptions): Promise<StorageFile> {
    const { bucket, key, file, mimeType, originalName, metadata } = options;
    const fullPath = this.getFullPath(bucket, key);

    await this.ensureDir(path.dirname(fullPath));

    let buffer: Buffer;
    if (Buffer.isBuffer(file)) {
      buffer = file;
    } else if (file instanceof ReadableStream) {
      const chunks: Uint8Array[] = [];
      const reader = file.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      buffer = Buffer.concat(chunks);
    } else {
      const chunks: Uint8Array[] = [];
      for await (const chunk of file) {
        chunks.push(chunk);
      }
      buffer = Buffer.concat(chunks);
    }

    const etag = createHash('md5').update(buffer).digest('hex');

    await fs.writeFile(fullPath, buffer);

    const url = `/storage/${bucket}/${key}`;

    return {
      key,
      bucket,
      originalName,
      mimeType,
      size: buffer.length,
      etag,
      url,
      uploadedAt: new Date(),
    };
  }

  async download(options: DownloadOptions): Promise<Buffer> {
    const { bucket, key } = options;
    const fullPath = this.getFullPath(bucket, key);

    try {
      return await fs.readFile(fullPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('File not found');
      }
      throw err;
    }
  }

  async delete(options: DeleteOptions): Promise<void> {
    const { bucket, key } = options;
    const fullPath = this.getFullPath(bucket, key);

    try {
      await fs.unlink(fullPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async getPresignedUrl(options: PresignedUrlOptions): Promise<string> {
    const { bucket, key, method = 'GET' } = options;
    return `/storage/${bucket}/${key}`;
  }

  async fileExists(bucket: string, key: string): Promise<boolean> {
    const fullPath = this.getFullPath(bucket, key);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async getFileInfo(bucket: string, key: string): Promise<StorageFile | null> {
    const fullPath = this.getFullPath(bucket, key);
    try {
      const stats = await fs.stat(fullPath);
      const buffer = await fs.readFile(fullPath);
      const etag = createHash('md5').update(buffer).digest('hex');

      return {
        key,
        bucket,
        originalName: key,
        mimeType: 'application/octet-stream',
        size: stats.size,
        etag,
        url: `/storage/${bucket}/${key}`,
        uploadedAt: stats.mtime,
      };
    } catch {
      return null;
    }
  }

  async listFiles(bucket: string, prefix?: string): Promise<StorageFile[]> {
    const bucketPath = path.join(this.basePath, bucket);
    const files: StorageFile[] = [];

    async function walk(dir: string, relativePath: string = ''): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relPath = path.join(relativePath, entry.name);
          if (entry.isDirectory()) {
            await walk(fullPath, relPath);
          } else if (!prefix || relPath.startsWith(prefix)) {
            const stats = await fs.stat(fullPath);
            const buffer = await fs.readFile(fullPath);
            const etag = createHash('md5').update(buffer).digest('hex');
            files.push({
              key: relPath,
              bucket,
              originalName: entry.name,
              mimeType: 'application/octet-stream',
              size: stats.size,
              etag,
              url: `/storage/${bucket}/${relPath}`,
              uploadedAt: stats.mtime,
            });
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
    }

    await walk(bucketPath);
    return files;
  }
}

class S3StorageProvider implements StorageProviderInterface {
  // TODO: Implement S3 provider when needed
  // This would use @aws-sdk/client-s3
  async upload(): Promise<StorageFile> {
    throw new Error('S3 provider not implemented yet');
  }
  async download(): Promise<Buffer> {
    throw new Error('S3 provider not implemented yet');
  }
  async delete(): Promise<void> {
    throw new Error('S3 provider not implemented yet');
  }
  async getPresignedUrl(): Promise<string> {
    throw new Error('S3 provider not implemented yet');
  }
  async fileExists(): Promise<boolean> {
    throw new Error('S3 provider not implemented yet');
  }
  async getFileInfo(): Promise<StorageFile | null> {
    throw new Error('S3 provider not implemented yet');
  }
  async listFiles(): Promise<StorageFile[]> {
    throw new Error('S3 provider not implemented yet');
  }
}

function createStorageProvider(): StorageProviderInterface {
  const provider = config.STORAGE_PROVIDER;

  switch (provider) {
    case StorageProvider.LOCAL:
      return new LocalStorageProvider(config.STORAGE_LOCAL_PATH);
    case StorageProvider.S3:
    case StorageProvider.R2:
    case StorageProvider.MINIO:
      return new S3StorageProvider();
    default:
      throw new Error(`Unknown storage provider: ${provider}`);
  }
}

export const storage = createStorageProvider();

export function validateFileUpload(file: {
  name: string;
  type: string;
  size: number;
}): { valid: boolean; error?: string } {
  const allowedTypes: string[] = [
    ...FILE_UPLOAD.ALLOWED_IMAGE_TYPES,
    ...FILE_UPLOAD.ALLOWED_AUDIO_TYPES,
  ];

  if (!allowedTypes.includes(file.type)) {
    return { valid: false, error: `File type ${file.type} not allowed` };
  }

  if (file.size > FILE_UPLOAD.MAX_FILE_SIZE) {
    return { valid: false, error: `File size exceeds maximum allowed size of ${FILE_UPLOAD.MAX_FILE_SIZE} bytes` };
  }

  return { valid: true };
}

export function generateStorageKey(
  bucket: string,
  originalName: string,
  userId?: string
): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  const ext = path.extname(originalName).toLowerCase();
  const prefix = userId ? `${userId}/` : '';
  return `${prefix}${timestamp}-${random}${ext}`;
}

export function getBucketForFileType(fileType: FileType): string {
  switch (fileType) {
    case FileType.IMAGE:
      return STORAGE_BUCKETS.AVATARS;
    case FileType.AUDIO:
      return STORAGE_BUCKETS.VOICE_MESSAGES;
    default:
      return STORAGE_BUCKETS.AVATARS;
  }
}

export { STORAGE_BUCKETS, FILE_UPLOAD } from '@socialplay/shared';