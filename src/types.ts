/**
 * Type definitions for Borg MCP Client
 */

export interface GoogleOAuthTokens {
  id_token: string;
  refresh_token?: string;
  expires_at: number;      // Unix timestamp
}
