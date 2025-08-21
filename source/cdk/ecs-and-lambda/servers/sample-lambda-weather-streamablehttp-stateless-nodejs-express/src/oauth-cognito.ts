/**
 * OAuth handling functionality for MCP server authentication.
 * Provides OAuth 2.0 authorization code flow implementation.
 */

import * as jose from "jose";
import fetch from "node-fetch";

/**
 * Validate a Cognito access token.
 */
export async function validateCognitoToken(
  token: string
): Promise<{ isValid: boolean; claims: any }> {
  const region = process.env.AWS_REGION || "us-west-2";
  const user_pool_id = process.env.COGNITO_USER_POOL_ID;
  const client_id = process.env.COGNITO_CLIENT_ID;

  // Get the JWKs from Cognito
  const jwks_url = `https://cognito-idp.${region}.amazonaws.com/${user_pool_id}/.well-known/jwks.json`;

  try {
    // Fetch the JWKS
    const jwks_response = await fetch(jwks_url);
    const jwks = (await jwks_response.json()) as { keys: any[] };

    // Get the key ID from the token header
    const { kid } = await jose.decodeProtectedHeader(token);
    if (!kid) {
      return { isValid: false, claims: {} };
    }

    // Find the correct key
    const key = jwks.keys.find((k: any) => k.kid === kid);
    if (!key) {
      return { isValid: false, claims: {} };
    }

    // Create JWKS
    const JWKS = jose.createLocalJWKSet({ keys: [key] });

    // Define expected issuer
    const issuer = `https://cognito-idp.${region}.amazonaws.com/${user_pool_id}`;

    // Verify the token with RS256 algorithm
    const { payload } = await jose.jwtVerify(token, JWKS, {
      issuer,
      algorithms: ["RS256"],
    });

    // Additional validations for Cognito access tokens
    if (payload.token_use !== "access") {
      console.log(`Invalid token_use: ${payload.token_use}, expected: access`);
      return { isValid: false, claims: {} };
    }

    // For access tokens, client_id is in the 'client_id' claim, not 'aud'
    if (payload.client_id !== client_id) {
      console.log(
        `Invalid client_id: ${payload.client_id}, expected: ${client_id}`
      );
      return { isValid: false, claims: {} };
    }

    return { isValid: true, claims: payload };
  } catch (error) {
    console.error("Token validation error:", error);
    return { isValid: false, claims: {} };
  }
}
