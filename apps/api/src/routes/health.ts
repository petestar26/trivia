import { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';

interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  uptime: number;
  timestamp: string;
  services: {
    database: 'ok' | 'error';
    memory: {
      used: number;
      total: number;
      percent: number;
    };
  };
}

export async function healthRoutes(server: FastifyInstance): Promise<void> {
  server.get<{ Querystring: { detailed?: string } }>(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            detailed: { type: 'string' },
          },
        },
      },
    },
    async (request, reply): Promise<HealthStatus | { status: string }> => {
      let dbOk = true;
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch (err) {
        dbOk = false;
        server.log.error({ err }, 'Database health check failed');
      }

      const mem = process.memoryUsage();
      const health: HealthStatus = {
        status: dbOk ? 'ok' : 'degraded',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        services: {
          database: dbOk ? 'ok' : 'error',
          memory: {
            used: Math.round(mem.heapUsed / 1024 / 1024),
            total: Math.round(mem.heapTotal / 1024 / 1024),
            percent: Math.round((mem.heapUsed / mem.heapTotal) * 100),
          },
        },
      };

      reply.status(dbOk ? 200 : 503);
      return request.query.detailed !== undefined ? health : { status: health.status };
    }
  );
}