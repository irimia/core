export const defaults = {
    server: {
        banSeconds: process.env.CORE_P2P_BAN_SECONDS || 60,
        hostname: process.env.CORE_P2P_HOST || "0.0.0.0",
        port: process.env.CORE_P2P_PORT || 4002,
        logLevel: process.env.CORE_NETWORK_NAME === "testnet" ? 1 : 0,
    },
    /**
     * The minimum peer version we expect
     */
    minimumVersions: ["^3.0", "^3.0.0-next.0", "^3.0.0-alpha.0"],
    /**
     * The number of peers we expect to be available to start a relay
     */
    minimumNetworkReach: process.env.CORE_P2P_MIN_NETWORK_REACH || 20,
    /**
     * The timeout to verify a peer. [milliseconds]
     */
    verifyTimeout: 60000,
    /**
     * The timeout to download a batch of blocks (400). Notice that we start
     * 25 concurrent such downloads, so the network may be saturated. [milliseconds]
     */
    getBlocksTimeout: 30000,
    /**
     * The maximum number of peers we will broadcast data to
     */
    maxPeersBroadcast: 20,
    /**
     * The maximum authorized number of peers sharing same ip /24 subnet
     */
    maxSameSubnetPeers: process.env.CORE_P2P_MAX_PEERS_SAME_SUBNET || 256,
    /**
     * The maximum peer consecutive errors before peer is forget from peer store.
     */
    maxPeerSequentialErrors: process.env.CORE_P2P_MAX_PEER_SEQUENTIAL_ERRORS || 3,
    /**
     * The list of IPs we allow to be added to the peer list.
     */
    whitelist: ["*"],
    /**
     * The list of IPs we do not allow to be added to the peer list.
     */
    blacklist: [],
    /**
     * The list of IPs can access the remote/internal API.
     *
     * This should usually only include your localhost to grant access to
     * the internal API to your forger. If you run a split relay and forger
     * you will need to specify the IP of your forger here.
     */
    remoteAccess: ["127.0.0.1", "::ffff:127.0.0.1", "::1"],
    /**
     * The DNS servers we use to verify connectivity
     */
    dns: [
        // Google
        "8.8.8.8",
        "8.8.4.4",
        // CloudFlare
        "1.1.1.1",
        "1.0.0.1",
        // OpenDNS
        "208.67.222.222",
        "208.67.220.220",
    ],
    /**
     * The NTP servers we use to verify connectivity
     */
    ntp: ["pool.ntp.org", "time.google.com"],
    /**
     * Rate limit config
     */
    rateLimit: process.env.CORE_P2P_RATE_LIMIT || 100, // max number of messages per second per socket connection
    rateLimitPostTransactions: process.env.CORE_P2P_RATE_LIMIT_POST_TRANSACTIONS || 25, // postTransactions endpoint
};
