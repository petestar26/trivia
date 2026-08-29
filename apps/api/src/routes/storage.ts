import { FastifyInstance } from 'fastify';
import { promises as fs } from 'fs';
import { createReadStream } from 'fs';
import path from 'path';
import { config } from '@socialplay/config';

const MIME_TYPES: Record<string, string> = {
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
  '.mp4': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

interface StorageFileParams {
  bucket: string;
  '*': string;
}

export async function storageRoutes(server: FastifyInstance): Promise<void> {
  // Serve files from local storage directory: /storage/:bucket/*
  server.get<{ Params: StorageFileParams }>(
    '/:bucket/*',
    async (request, reply) => {
      const { bucket, '*': key } = request.params;

      // Validate bucket name to prevent directory traversal
      if (!bucket || !/^[a-z0-9-]+$/i.test(bucket)) {
        return reply.status(400).send({ success: false, error: 'Invalid bucket name' });
      }

      // Validate key to prevent path traversal
      if (!key || key.includes('..') || key.includes('\0')) {
        return reply.status(400).send({ success: false, error: 'Invalid file key' });
      }

      const basePath = config.STORAGE_LOCAL_PATH;
      const fullPath = path.join(basePath, bucket, key);

      // Resolve and verify the path is within the base directory
      const resolvedBase = path.resolve(basePath);
      const resolvedPath = path.resolve(fullPath);

      if (!resolvedPath.startsWith(resolvedBase + path.sep) && resolvedPath !== resolvedBase) {
        return reply.status(403).send({ success: false, error: 'Access denied' });
      }

      try {
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile()) {
          return reply.status(404).send({ success: false, error: 'File not found' });
        }

        const mimeType = getMimeType(resolvedPath);

        reply.header('Content-Type', mimeType);
        reply.header('Content-Length', stat.size);
        reply.header('Accept-Ranges', 'bytes');
        reply.header('Cache-Control', 'private, max-age=3600');

        return reply.send(createReadStream(resolvedPath));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.status(404).send({ success: false, error: 'File not found' });
        }
        return reply.status(500).send({ success: false, error: 'Internal server error' });
      }
    }
  );
}
