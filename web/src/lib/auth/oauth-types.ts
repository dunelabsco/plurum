export type OAuthBindingState = {
  grant_id: string | null;
  state: "active" | "revoking" | "revoked" | null;
};

export type OAuthConnection = {
  client_id: string;
  client_name: string | null;
  grant_id: string | null;
  state: "connected" | "unbound" | "revocation_pending";
  agent_id: string | null;
  agent_name: string | null;
  agent_username: string | null;
  agent_active: boolean;
};
