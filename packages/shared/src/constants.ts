export const APP_NAME = 'SocialPlay';
export const APP_VERSION = '0.0.1';

export const API_PREFIX = '/api/v1';
export const WS_PATH = '/ws';

export const COOKIE_NAMES = {
  ACCESS_TOKEN: 'sp_access_token',
  REFRESH_TOKEN: 'sp_refresh_token',
} as const;

export const HEADER_NAMES = {
  AUTHORIZATION: 'authorization',
  CONTENT_TYPE: 'content-type',
  X_REQUEST_ID: 'x-request-id',
} as const;

export const PAGINATION = {
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

export const FILE_UPLOAD = {
  MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  ALLOWED_AUDIO_TYPES: ['audio/ogg', 'audio/webm', 'audio/mp4', 'audio/mpeg'],
} as const satisfies {
  MAX_FILE_SIZE: number;
  ALLOWED_IMAGE_TYPES: string[];
  ALLOWED_AUDIO_TYPES: string[];
};

export const STORAGE_BUCKETS = {
  AVATARS: 'avatars',
  GROUP_IMAGES: 'group-images',
  VOICE_MESSAGES: 'voice-messages',
  GIFT_ASSETS: 'gift-assets',
  GAME_ASSETS: 'game-assets',
} as const;

export const RATE_LIMIT = {
  DEFAULT_WINDOW_MS: 60 * 1000, // 1 minute
  DEFAULT_MAX_REQUESTS: 100,
  AUTH_WINDOW_MS: 15 * 60 * 1000, // 15 minutes
  AUTH_MAX_REQUESTS: 10,
} as const;

export const JWT = {
  ACCESS_TOKEN_EXPIRY: '15m',
  REFRESH_TOKEN_EXPIRY: '30d',
  ISSUER: 'socialplay',
  AUDIENCE: 'socialplay',
} as const;

export const PASSWORD = {
  MIN_LENGTH: 8,
  MAX_LENGTH: 128,
  REQUIRE_UPPERCASE: true,
  REQUIRE_LOWERCASE: true,
  REQUIRE_NUMBER: true,
  REQUIRE_SYMBOL: true,
} as const;

export const USERNAME = {
  MIN_LENGTH: 3,
  MAX_LENGTH: 30,
  PATTERN: /^[a-zA-Z0-9_]+$/,
} as const;

export const GROUP = {
  NAME_MIN_LENGTH: 2,
  NAME_MAX_LENGTH: 100,
  DESCRIPTION_MAX_LENGTH: 500,
  MAX_MEMBERS: 10000,
} as const;

export const CHAT = {
  MESSAGE_MAX_LENGTH: 5000,
  VOICE_MESSAGE_MAX_DURATION_SECONDS: 300, // 5 minutes
} as const;