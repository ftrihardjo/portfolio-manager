import { kvs } from "@forge/kvs";

export const githubSettingsResolvers = {
  saveGithubSettings: async (req) => {
    const { appId, webhookSecret, privateKey } = req.payload;

    // Store App ID in plain text (it's not a secret)
    await kvs.set('github_app_id', appId);

    // Store sensitive data encrypted in Forge KVS
    await kvs.setSecret('github_webhook_secret', webhookSecret);
    await kvs.setSecret('github_private_key', privateKey);

    return { success: true };
  },

  getGithubSettings: async () => {
    const appId = await kvs.get('github_app_id');
    const hasKey = !!(await kvs.getSecret('github_private_key'));

    // NEVER return the private key or webhook secret to the frontend
    return {
      appId: appId || '',
      isConfigured: !!(appId && hasKey)
    };
  },

  deleteGithubSettings: async () => {
    await kvs.delete('github_app_id');
    await kvs.deleteSecret('github_webhook_secret');
    await kvs.deleteSecret('github_private_key');
    return { success: true };
  }
};