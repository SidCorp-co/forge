const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:1337/api';

interface AuthResponse {
  jwt: string;
  user: { id: number; username: string; email: string; isCEO?: boolean };
}

interface UserResponse {
  id: number;
  username: string;
  email: string;
  isCEO?: boolean;
}

export const authApi = {
  login: async (identifier: string, password: string): Promise<AuthResponse> => {
    const res = await fetch(`${API_URL}/auth/local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err?.error?.message || 'Login failed');
    }
    return res.json();
  },

  register: async (username: string, email: string, password: string): Promise<AuthResponse> => {
    const res = await fetch(`${API_URL}/auth/local/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err?.error?.message || 'Registration failed');
    }
    return res.json();
  },

  verify: async (jwt: string): Promise<UserResponse> => {
    const res = await fetch(`${API_URL}/users/me`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) throw new Error('Invalid token');
    return res.json();
  },
};
