const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const GOOGLE_DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

const CALENDAR_BUILDING_ID = "google-calendar";
const GMAIL_BUILDING_ID = "gmail";
const DRIVE_BUILDING_ID = "google-drive";

const TOKEN_REFRESH_SKEW_MS = 60_000;

function buildHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safeJsonParse(raw) {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractGoogleErrorMessage(payload, fallback) {
  if (payload && typeof payload === "object") {
    if (payload.error_description) {
      return String(payload.error_description);
    }
    if (payload.error && typeof payload.error === "object") {
      const errorObject = payload.error;
      if (errorObject.message) {
        return String(errorObject.message);
      }
      if (Array.isArray(errorObject.errors) && errorObject.errors[0]?.message) {
        return String(errorObject.errors[0].message);
      }
    }
    if (typeof payload.error === "string") {
      return String(payload.error);
    }
    if (payload.message) {
      return String(payload.message);
    }
  }
  return fallback;
}

function appendSearchParams(url, params = {}) {
  const target = url instanceof URL ? url : new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    target.searchParams.set(key, String(value));
  }
  return target.toString();
}

export class GoogleService {
  constructor({ tokenStore, settingsStore, fetchImpl = globalThis.fetch } = {}) {
    if (!tokenStore) {
      throw new Error("GoogleService requires a tokenStore.");
    }
    if (!settingsStore) {
      throw new Error("GoogleService requires a settingsStore.");
    }
    this.tokenStore = tokenStore;
    this.settingsStore = settingsStore;
    this.fetch = fetchImpl;
  }

  getCredentials() {
    const settings = this.settingsStore.settings || {};
    const clientId = String(settings.googleOAuthClientId || "").trim();
    const clientSecret = String(settings.googleOAuthClientSecret || "").trim();
    return { clientId, clientSecret };
  }

  async exchangeAuthCode({ buildingId, code, redirectUri } = {}) {
    const normalizedCode = String(code || "").trim();
    const normalizedRedirectUri = String(redirectUri || "").trim();
    if (!buildingId) {
      throw buildHttpError("Building id is required for Google OAuth token exchange.", 400);
    }
    if (!normalizedCode) {
      throw buildHttpError("Authorization code is required for Google OAuth token exchange.", 400);
    }
    if (!normalizedRedirectUri) {
      throw buildHttpError("Redirect URI is required for Google OAuth token exchange.", 400);
    }

    const { clientId, clientSecret } = this.getCredentials();
    if (!clientId || !clientSecret) {
      throw buildHttpError("Google OAuth client id and secret must be configured.", 400);
    }

    const body = new URLSearchParams({
      code: normalizedCode,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: normalizedRedirectUri,
      grant_type: "authorization_code",
    }).toString();

    const payload = await this.requestTokenEndpoint(body);
    const accessToken = String(payload.access_token || "").trim();
    if (!accessToken) {
      throw buildHttpError("Google did not return an access token.", 502);
    }
    const refreshToken = String(payload.refresh_token || "").trim();
    const expiresIn = Number(payload.expires_in) || 0;
    const scopes = String(payload.scope || "")
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
    const expiresAt = Date.now() + expiresIn * 1000 - TOKEN_REFRESH_SKEW_MS;

    await this.tokenStore.setTokens(buildingId, {
      accessToken,
      refreshToken: refreshToken || undefined,
      expiresAt,
      scopes,
    });

    return this.tokenStore.getTokens(buildingId);
  }

  async refreshAccessToken(buildingId) {
    if (!buildingId) {
      throw buildHttpError("Building id is required for Google OAuth refresh.", 400);
    }

    const tokens = this.tokenStore.getTokens(buildingId);
    if (!tokens || !tokens.refreshToken) {
      throw buildHttpError(
        `No Google refresh token stored for ${buildingId}. Reconnect the building.`,
        401,
      );
    }

    const { clientId, clientSecret } = this.getCredentials();
    if (!clientId || !clientSecret) {
      throw buildHttpError("Google OAuth client id and secret must be configured.", 400);
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    }).toString();

    const payload = await this.requestTokenEndpoint(body);
    const accessToken = String(payload.access_token || "").trim();
    if (!accessToken) {
      throw buildHttpError("Google did not return a refreshed access token.", 502);
    }
    const expiresIn = Number(payload.expires_in) || 0;
    const newRefreshToken = String(payload.refresh_token || "").trim();
    const scopes = payload.scope
      ? String(payload.scope)
          .split(/\s+/)
          .map((scope) => scope.trim())
          .filter(Boolean)
      : tokens.scopes;
    const expiresAt = Date.now() + expiresIn * 1000 - TOKEN_REFRESH_SKEW_MS;

    await this.tokenStore.setTokens(buildingId, {
      accessToken,
      refreshToken: newRefreshToken || undefined,
      expiresAt,
      scopes,
    });

    return this.tokenStore.getTokens(buildingId);
  }

  async getValidAccessToken(buildingId) {
    const tokens = this.tokenStore.getTokens(buildingId);
    if (!tokens) {
      throw buildHttpError(
        `Google building ${buildingId} is not connected. Complete OAuth setup first.`,
        401,
      );
    }

    const now = Date.now();
    const expiresAt = Number(tokens.expiresAt || 0);
    const isExpired = !expiresAt || expiresAt <= now + TOKEN_REFRESH_SKEW_MS;
    if (!isExpired && tokens.accessToken) {
      return tokens.accessToken;
    }

    const refreshed = await this.refreshAccessToken(buildingId);
    return refreshed.accessToken;
  }

  async requestTokenEndpoint(body) {
    if (typeof this.fetch !== "function") {
      throw buildHttpError("fetch is not available for Google OAuth token exchange.", 500);
    }

    const response = await this.fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const raw = await response.text().catch(() => "");
    const payload = safeJsonParse(raw) || (raw ? { error_description: raw } : {});
    if (!response.ok) {
      const message = extractGoogleErrorMessage(
        payload,
        `Google OAuth token request failed (${response.status}).`,
      );
      throw buildHttpError(message, response.status || 400);
    }
    return payload;
  }

  async requestGoogleApi(buildingId, { url, method = "GET", body } = {}) {
    if (typeof this.fetch !== "function") {
      throw buildHttpError("fetch is not available for Google API requests.", 500);
    }

    const doRequest = async (accessToken) => {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
      };
      let requestBody;
      if (body !== undefined && body !== null) {
        headers["Content-Type"] = "application/json";
        requestBody = typeof body === "string" ? body : JSON.stringify(body);
      }
      const response = await this.fetch(url, {
        method,
        headers,
        body: requestBody,
      });
      const raw = await response.text().catch(() => "");
      const payload = safeJsonParse(raw);
      return { response, payload, raw };
    };

    let accessToken = await this.getValidAccessToken(buildingId);
    let { response, payload, raw } = await doRequest(accessToken);

    if (response.status === 401) {
      try {
        const refreshed = await this.refreshAccessToken(buildingId);
        accessToken = refreshed.accessToken;
      } catch (error) {
        if (!error.statusCode) {
          error.statusCode = 401;
        }
        throw error;
      }
      ({ response, payload, raw } = await doRequest(accessToken));
      if (response.status === 401) {
        throw buildHttpError(
          `Google rejected the refreshed access token for ${buildingId}. Reconnect the building.`,
          401,
        );
      }
    }

    if (!response.ok) {
      const message = extractGoogleErrorMessage(
        payload,
        raw || `Google API request failed (${response.status}).`,
      );
      throw buildHttpError(message, response.status || 400);
    }

    return payload ?? {};
  }

  async listCalendarEvents({
    calendarId = "primary",
    timeMin,
    timeMax,
    maxResults = 25,
    q,
  } = {}) {
    const url = appendSearchParams(
      `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        timeMin,
        timeMax,
        maxResults,
        singleEvents: "true",
        orderBy: "startTime",
        q,
      },
    );
    return this.requestGoogleApi(CALENDAR_BUILDING_ID, { url, method: "GET" });
  }

  async queryFreeBusy({ timeMin, timeMax, calendars = ["primary"] } = {}) {
    const items = (Array.isArray(calendars) ? calendars : ["primary"])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
      .map((id) => ({ id }));
    return this.requestGoogleApi(CALENDAR_BUILDING_ID, {
      url: `${GOOGLE_CALENDAR_API_BASE}/freeBusy`,
      method: "POST",
      body: {
        timeMin,
        timeMax,
        items,
      },
    });
  }

  async createCalendarEvent({ calendarId = "primary", event } = {}) {
    if (!event || typeof event !== "object") {
      throw buildHttpError("Calendar event payload is required.", 400);
    }
    return this.requestGoogleApi(CALENDAR_BUILDING_ID, {
      url: `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      method: "POST",
      body: event,
    });
  }

  async searchGmailThreads({ q = "", maxResults = 20, pageToken } = {}) {
    const url = appendSearchParams(`${GMAIL_API_BASE}/users/me/threads`, {
      q,
      maxResults,
      pageToken,
    });
    return this.requestGoogleApi(GMAIL_BUILDING_ID, { url, method: "GET" });
  }

  async getGmailThread({ threadId, format = "full" } = {}) {
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) {
      throw buildHttpError("Gmail thread id is required.", 400);
    }
    const url = appendSearchParams(
      `${GMAIL_API_BASE}/users/me/threads/${encodeURIComponent(normalizedThreadId)}`,
      { format },
    );
    return this.requestGoogleApi(GMAIL_BUILDING_ID, { url, method: "GET" });
  }

  async searchDriveFiles({
    q,
    pageSize = 25,
    pageToken,
    orderBy = "modifiedTime desc",
    fields = "files(id,name,mimeType,modifiedTime,owners(displayName,emailAddress),webViewLink,size),nextPageToken",
    spaces = "drive",
    corpora,
    includeItemsFromAllDrives,
    supportsAllDrives,
    driveId,
  } = {}) {
    const url = appendSearchParams(`${GOOGLE_DRIVE_API_BASE}/files`, {
      q,
      pageSize,
      pageToken,
      orderBy,
      fields,
      spaces,
      corpora,
      includeItemsFromAllDrives,
      supportsAllDrives,
      driveId,
    });
    return this.requestGoogleApi(DRIVE_BUILDING_ID, { url, method: "GET" });
  }

  async getDriveFile({
    fileId,
    fields = "id,name,mimeType,modifiedTime,owners(displayName,emailAddress),webViewLink,size,parents",
    supportsAllDrives,
  } = {}) {
    const normalizedFileId = String(fileId || "").trim();
    if (!normalizedFileId) {
      throw buildHttpError("Google Drive file id is required.", 400);
    }
    const url = appendSearchParams(
      `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(normalizedFileId)}`,
      { fields, supportsAllDrives },
    );
    return this.requestGoogleApi(DRIVE_BUILDING_ID, { url, method: "GET" });
  }

  async exportDriveFile({ fileId, mimeType = "text/plain" } = {}) {
    const normalizedFileId = String(fileId || "").trim();
    if (!normalizedFileId) {
      throw buildHttpError("Google Drive file id is required.", 400);
    }
    const normalizedMimeType = String(mimeType || "").trim();
    if (!normalizedMimeType) {
      throw buildHttpError("Drive export mimeType is required.", 400);
    }
    const url = appendSearchParams(
      `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(normalizedFileId)}/export`,
      { mimeType: normalizedMimeType },
    );
    return this.requestGoogleApiText(DRIVE_BUILDING_ID, { url, method: "GET" });
  }

  async requestGoogleApiText(buildingId, { url, method = "GET" } = {}) {
    if (typeof this.fetch !== "function") {
      throw buildHttpError("fetch is not available for Google API requests.", 500);
    }

    const doRequest = async (accessToken) => {
      const response = await this.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const raw = await response.text().catch(() => "");
      return { response, raw };
    };

    let accessToken = await this.getValidAccessToken(buildingId);
    let { response, raw } = await doRequest(accessToken);

    if (response.status === 401) {
      try {
        const refreshed = await this.refreshAccessToken(buildingId);
        accessToken = refreshed.accessToken;
      } catch (error) {
        if (!error.statusCode) {
          error.statusCode = 401;
        }
        throw error;
      }
      ({ response, raw } = await doRequest(accessToken));
      if (response.status === 401) {
        throw buildHttpError(
          `Google rejected the refreshed access token for ${buildingId}. Reconnect the building.`,
          401,
        );
      }
    }

    if (!response.ok) {
      const payload = safeJsonParse(raw);
      const message = extractGoogleErrorMessage(
        payload,
        raw || `Google API request failed (${response.status}).`,
      );
      throw buildHttpError(message, response.status || 400);
    }

    return {
      contentType: response.headers?.get?.("content-type") || "",
      body: raw,
    };
  }
}

export const GOOGLE_SERVICE_BUILDING_IDS = Object.freeze({
  CALENDAR: CALENDAR_BUILDING_ID,
  GMAIL: GMAIL_BUILDING_ID,
  DRIVE: DRIVE_BUILDING_ID,
});
