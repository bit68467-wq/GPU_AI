/* New file: realBackend.js - extracted real axios-based backend from api.js */
export const RealBackend = {
    _client(token) {
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        return axios.create({
            baseURL: window.CUP9_API_BASE,
            headers,
            timeout: 10000
        });
    },

    async register(email, password, referralCode = null) {
        try {
            const res = await this._client().post('/auth/register', { email, password, referral: referralCode });
            return { success: true, data: res.data };
        } catch (err) {
            return { success: false, error: err?.response?.data?.error || err.message };
        }
    },

    async login(email, password) {
        try {
            const res = await this._client().post('/auth/login', { email, password });
            return { success: true, data: res.data };
        } catch (err) {
            return { success: false, error: err?.response?.data?.error || err.message };
        }
    },

    async loginTelegram() {
        try {
            const res = await this._client().post('/auth/telegram');
            return { success: true, data: res.data };
        } catch (err) {
            return { success: false, error: err?.response?.data?.error || err.message };
        }
    },

    async me(token) {
        try {
            const res = await this._client(token).get('/me');
            return { success: true, data: res.data };
        } catch (err) {
            return { success: false, error: err?.response?.data?.error || 'Unauthorized' };
        }
    },

    async getGpus(token) {
        try {
            const res = await this._client(token).get('/gpus');
            return { success: true, data: res.data };
        } catch (err) {
            return { success: false, error: err?.message || 'Error' };
        }
    },

    async getMarketGpus(token) {
        try {
            const res = await this._client(token).get('/gpus/market');
            return { success: true, data: res.data };
        } catch (err) {
            return { success: false, error: err?.message || 'Error' };
        }
    },

    async buyGpu(token, gpuId) {
        try {
            const res = await this._client(token).post(`/gpus/${encodeURIComponent(gpuId)}/buy`);
            return { success: true, data: res.data };
        } catch (err) {
            return { success: false, error: err?.response?.data?.error || err?.message || 'Error' };
        }
    },

    async buyLicense(token, licenseId = 'license-base') {
        try {
            // send license type to server so backend can charge correct amount
            const payload = { licenseId };
            const res = await this._client(token).post('/purchase/license', payload);
            return { success: true, data: res.data };
        } catch (err) {
            return { success: false, error: err?.response?.data?.error || err?.message || 'Error' };
        }
    },

    async getTransactions(token) {
        try {
            const res = await this._client(token).get('/transactions');
            return { success: true, data: res.data };
        } catch (err) {
            return { success: false, error: err?.message || 'Error' };
        }
    },

    async createTransaction(token, type, amount, metadata = {}) {
        try {
            const payload = { type, amount, metadata };
            const res = await this._client(token).post('/transactions', payload);
            return { success: true, data: res.data };
        } catch (err) {
            return { success: false, error: err?.response?.data?.error || err?.message || 'Error' };
        }
    },

    async getAllUsers(token) {
        try {
            const res = await this._client(token).get('/admin/users');
            return { success: true, data: res.data };
        } catch (err) {
            return { success: false, error: err?.message || 'Error' };
        }
    },

    async getAllTransactions(token) {
        try {
            const res = await this._client(token).get('/admin/transactions');
            return { success: true, data: res.data };
        } catch (err) {
            return { success: false, error: err?.message || 'Error' };
        }
    },

    async updateTransactionStatus(token, txId, status) {
        try {
            const res = await this._client(token).patch(`/transactions/${encodeURIComponent(txId)}/status`, { status });
            return { success: true, data: res.data };
        } catch (err) {
            return { success: false, error: err?.response?.data?.error || err?.message || 'Error' };
        }
    },

    // Support admin-provided txHash during approval: servers may accept adminTxHash in payload
    async updateTransactionStatusWithHash(token, txId, status, adminTxHash = null) {
        try {
            const payload = { status };
            if (adminTxHash) payload.adminTxHash = adminTxHash;
            const res = await this._client(token).patch(`/transactions/${encodeURIComponent(txId)}/status`, payload);
            return { success: true, data: res.data };
        } catch (err) {
            return { success: false, error: err?.response?.data?.error || err?.message || 'Error' };
        }
    },

    async updateUser(token, userId, updates) {
        try {
            const res = await this._client(token).patch(`/users/${encodeURIComponent(userId)}`, updates);
            return { success: true, data: res.data };
        } catch (err) {
            return { success: false, error: err?.response?.data?.error || err?.message || 'Error' };
        }
    },

    // Admin alias: enable/disable second admin and read status
    // Calls mirror the server endpoints: POST /api/admin/enable-alias and /api/admin/disable-alias
    // and GET /api/admin/alias (if available). When toggling we include adminEmail in body as middleware expects.
    async setAdminAlias(token = null, enabled = true) {
        try {
            const client = this._client(token);
            if (enabled) {
                const res = await client.post('/api/admin/enable-alias', { adminEmail: (token ? null : null) , adminEmailProvided: null, adminEmail: (token ? undefined : undefined) , adminEmail: (token && typeof token === 'string' ? null : null) , adminEmail: (token ? undefined : undefined) , adminEmail: (token ? undefined : undefined) , adminEmail: (token ? undefined : undefined) , adminEmail: (token ? undefined : undefined) });
                // some servers may return the payload directly or under res.data
                return { success: true, data: res.data || res };
            } else {
                const res = await client.post('/api/admin/disable-alias', { adminEmail: (token ? null : null) });
                return { success: true, data: res.data || res };
            }
        } catch (err) {
            return { success: false, error: err?.response?.data?.error || err?.message || 'Error' };
        }
    },

    async getAdminAlias(token = null) {
        try {
            // try a GET endpoint first
            const client = this._client(token);
            const res = await client.get('/api/admin/alias');
            return { success: true, data: res.data };
        } catch (err) {
            // fallback: some implementations may expose /api/admin/enable-alias state via POST-less endpoint
            try {
                const client = this._client(token);
                const res2 = await client.get('/api/admin/alias');
                return { success: true, data: res2.data };
            } catch (e) {
                return { success: false, error: err?.response?.data?.error || err?.message || 'Error fetching admin alias status' };
            }
        }
    }
};