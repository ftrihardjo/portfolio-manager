import { storage } from '@forge/api';

export const githubSettingsResolvers = {
  saveGithubSettings: async (req) => {
    const { appId, webhookSecret, privateKey } = req.payload;

    // Store App ID in plain text (it's not a secret)
    await storage.set('github_app_id', appId);

    // Store sensitive data encrypted in Forge KVS
    await storage.setSecret('github_webhook_secret', webhookSecret);
    await storage.setSecret('github_private_key', privateKey);

    return { success: true };
  },

  getGithubSettings: async () => {
    const appId = await storage.get('github_app_id');
    const hasKey = !!(await storage.getSecret('github_private_key'));

    // NEVER return the private key or webhook secret to the frontend
    return {
      appId: appId || '',
      isConfigured: !!(appId && hasKey)
    };
  },

  deleteGithubSettings: async () => {
    await storage.delete('github_app_id');
    await storage.deleteSecret('github_webhook_secret');
    await storage.deleteSecret('github_private_key');
    return { success: true };
  }
};