// Hand-typed response wrappers. Core returns bare arrays for list endpoints
// with an `X-Total-Count` header; `apiClientList` in `forge/web` reads that
// header and wraps the payload into `ListResponse<T>` for ergonomics.

export interface ListResponse<T> {
  items: T[];
  totalCount: number;
}

// Login response from `POST /api/auth/local`. Access token is also set as
// an httpOnly `forge_auth` cookie — clients should rely on the cookie for
// subsequent requests and keep `refreshToken` in localStorage.
export interface LoginResponse {
  token: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
  };
  emailVerificationRequired: boolean;
}

export interface RegisterResponse {
  userId: string;
  email: string;
}

export interface RefreshResponse {
  token: string;
  refreshToken: string;
}
