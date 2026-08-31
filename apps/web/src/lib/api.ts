const API_BASE = '/api/v1';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta?: Record<string, unknown>;
}

interface RequestOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
}

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE) {
    this.baseUrl = baseUrl;
  }

  private buildUrl(endpoint: string, params?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(`${this.baseUrl}${endpoint}`, window.location.origin);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      });
    }
    return url.toString();
  }

  private async request<T>(endpoint: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const { params, headers, ...fetchOptions } = options;
    const url = this.buildUrl(endpoint, params);

    const response = await fetch(url, {
      ...fetchOptions,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      credentials: 'include',
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = data.error || {
        code: 'UNKNOWN_ERROR',
        message: data.message || 'An unexpected error occurred',
      };
      throw new Error(JSON.stringify({ status: response.status, ...error }));
    }

    return data;
  }

  async get<T>(endpoint: string, params?: Record<string, string | number | boolean | undefined>): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { method: 'GET', params });
  }

  async post<T>(endpoint: string, body: unknown, params?: Record<string, string | number | boolean | undefined>): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
      params,
    });
  }

  async put<T>(endpoint: string, body: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async patch<T>(endpoint: string, body: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  async delete<T>(endpoint: string): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { method: 'DELETE' });
  }

  async upload<T>(endpoint: string, formData: FormData): Promise<ApiResponse<T>> {
    const response = await fetch(this.buildUrl(endpoint), {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = data.error || {
        code: 'UNKNOWN_ERROR',
        message: data.message || 'An unexpected error occurred',
      };
      throw new Error(JSON.stringify({ status: response.status, ...error }));
    }

    return data;
  }

  // Challenge API
  async createChallenge(body: CreateChallengeBody): Promise<ApiResponse<Challenge>> {
    return this.post('/challenges', body);
  }

  async getUserChallenges(): Promise<ApiResponse<Challenge[]>> {
    return this.get('/challenges');
  }

  async getChallengeById(challengeId: string): Promise<ApiResponse<Challenge>> {
    return this.get(`/challenges/${challengeId}`);
  }

  async acceptChallenge(challengeId: string): Promise<ApiResponse<{ id: string; status: string; acceptedAt: string }>> {
    return this.post(`/challenges/${challengeId}/accept`);
  }

  async declineChallenge(challengeId: string): Promise<ApiResponse<{ id: string; status: string }>> {
    return this.post(`/challenges/${challengeId}/decline`);
  }

  async cancelChallenge(challengeId: string): Promise<ApiResponse<{ id: string; status: string }>> {
    return this.post(`/challenges/${challengeId}/cancel`);
  }

  async playChallengeTurn(challengeId: string, clientData?: Record<string, unknown>): Promise<ApiResponse<any>> {
    return this.post(`/challenges/${challengeId}/play`, { clientData });
  }

  // Competition API
  async listCompetitionsForGroup(groupId: string): Promise<ApiResponse<Competition[]>> {
    return this.get(`/competitions/${groupId}`);
  }

  async createCompetition(body: CreateCompetitionBody): Promise<ApiResponse<Competition>> {
    return this.post(`/competitions/${body.groupId}`, body);
  }

  async getCompetitionForGroup(groupId: string, competitionId: string): Promise<ApiResponse<Competition>> {
    return this.get(`/competitions/${groupId}/${competitionId}`);
  }

  async joinCompetition(groupId: string, competitionId: string): Promise<ApiResponse<{ id: string; status: string }>> {
    return this.post(`/competitions/${groupId}/${competitionId}/join`);
  }

  async playCompetition(groupId: string, competitionId: string, clientData?: Record<string, unknown>): Promise<ApiResponse<any>> {
    return this.post(`/competitions/${groupId}/${competitionId}/play`, { clientData });
  }

  // Wallet / Economy
  async getWallet(): Promise<ApiResponse<any>> {
    return this.get('/wallet');
  }

  async getWalletTransactions(params?: { page?: number; limit?: number; currency?: string }): Promise<ApiResponse<any>> {
    return this.get('/wallet/transactions', params);
  }

  // Groups
  async listGroups(params?: { page?: number; limit?: number; query?: string }): Promise<ApiResponse<any>> {
    return this.get('/groups', params);
  }

  async getGroup(groupId: string): Promise<ApiResponse<any>> {
    return this.get(`/groups/${groupId}`);
  }

  async joinGroup(groupId: string): Promise<ApiResponse<any>> {
    return this.post(`/groups/${groupId}/join`);
  }

  async leaveGroup(groupId: string): Promise<ApiResponse<any>> {
    return this.post(`/groups/${groupId}/leave`);
  }

  async getGroupMessages(groupId: string, params?: { page?: number; limit?: number }): Promise<ApiResponse<any>> {
    return this.get(`/groups/${groupId}/messages`, params);
  }

  // VIP
  async getVip(): Promise<ApiResponse<any>> {
    return this.get('/vip');
  }

  // Progress (XP / Level)
  async getProgress(): Promise<ApiResponse<any>> {
    return this.get('/progress');
  }

  // Tasks
  async listTasks(): Promise<ApiResponse<any>> {
    return this.get('/tasks');
  }

  async claimTaskReward(taskId: string): Promise<ApiResponse<any>> {
    return this.post(`/tasks/${taskId}/claim`);
  }

  // Achievements
  async listAchievements(): Promise<ApiResponse<any>> {
    return this.get('/achievements');
  }

  // Gifts
  async listGifts(): Promise<ApiResponse<any>> {
    return this.get('/gifts');
  }

  async sendGift(body: { recipientId: string; giftId: string; quantity: number }): Promise<ApiResponse<any>> {
    return this.post('/gifts/send', body);
  }

  async listGiftTransactions(params?: { page?: number; limit?: number; role?: string }): Promise<ApiResponse<any>> {
    return this.get('/gifts/transactions', params);
  }
}

export const api = new ApiClient();

export function voiceMessageUrl(groupId: string, messageId: string): string {
  return `${API_BASE}/groups/${groupId}/voice-messages/${messageId}`;
}

// Challenge as returned by GET /challenges (list) — mapped shape.
// Also used as base for GET /challenges/:id (detail) which returns the raw Prisma
// record and additionally includes challengerId/challengedId as FK columns and
// game: { key, name } instead of top-level gameKey/gameName.
export interface Challenge {
  id: string;
  // Present in list response (mapped):
  gameKey?: string;
  gameName?: string;
  // Present in detail response (raw Prisma + include):
  game?: { key: string; name: string };
  challengerId?: string;
  challengedId?: string;
  // Present in both:
  challenger: { id: string; username?: string; displayName?: string };
  challenged: { id: string; username?: string; displayName?: string };
  entryAmount: number;
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  winnerId?: string | null;
  resultMeta?: {
    challengerScore?: number;
    challengedScore?: number;
    winnerId?: string | null;
    mySessionId?: string;
  } | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string | null;
  completedAt?: string | null;
}

export interface CreateChallengeBody {
  challengedId: string;
  gameKey: string;
  entryAmount?: number;
}

// Competition as returned by the backend (Prisma include shape).
// The backend uses { include: { game: { select: { key, name } } } }
// so the game name is in competition.game.name, not competition.gameName.
export interface Competition {
  id: string;
  groupId: string;
  game: { key: string; name: string };
  title: string;
  description?: string | null;
  status: 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  scoring?: string;
  entryAmount: number;
  maxParticipants?: number | null;
  rewardGamePoints: number;
  rewardCoins: number;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  createdBy?: string;
  finalizedAt?: string | null;
  finalizerId?: string | null;
  result?: unknown;
  participants?: { userId: string; score: number; gamesPlayed: number }[];
}

export interface CreateCompetitionBody {
  groupId: string;
  gameKey: string;
  title: string;
  description?: string;
  startsAt: string;
  endsAt: string;
  entryAmount?: number;
  maxParticipants?: number;
  rewardGamePoints?: number;
  rewardCoins?: number;
}