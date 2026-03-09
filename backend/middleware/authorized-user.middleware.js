function readCandidateValue(req, candidateKeys = []) {
    const keys = Array.isArray(candidateKeys) ? candidateKeys : [];
    const body = req && req.body && typeof req.body === 'object' ? req.body : {};
    const query = req && req.query && typeof req.query === 'object' ? req.query : {};
    const params = req && req.params && typeof req.params === 'object' ? req.params : {};
    const allSources = [query, params, body];
    for (const key of keys) {
        for (const source of allSources) {
            if (Object.prototype.hasOwnProperty.call(source, key)) {
                const value = source[key];
                if (value !== undefined && value !== null && String(value).trim()) {
                    return value;
                }
            }
        }
    }
    return '';
}

function createAuthorizedUserMiddleware(deps = {}) {
    const resolveAuthorizedUser = deps.resolveAuthorizedUser;
    const normalizeUserCandidate = deps.normalizeUserCandidate;
    const defaultCandidateKeys = Array.isArray(deps.defaultCandidateKeys) && deps.defaultCandidateKeys.length
        ? deps.defaultCandidateKeys
        : ['user', 'username', 'phone', 'sender', 'reader', 'reactor'];

    if (typeof resolveAuthorizedUser !== 'function') {
        throw new Error('createAuthorizedUserMiddleware requires resolveAuthorizedUser');
    }

    const attachResolvedUser = (req, _res, next) => {
        req.resolveAuthorizedUser = (candidateUser, options = {}) => {
            return resolveAuthorizedUser(req, candidateUser, options);
        };

        req.resolveAuthorizedUserFromRequest = (options = {}) => {
            const candidateKeys = Array.isArray(options.candidateKeys) && options.candidateKeys.length
                ? options.candidateKeys
                : defaultCandidateKeys;
            const candidate = readCandidateValue(req, candidateKeys);
            const required = options.required === true;
            return resolveAuthorizedUser(req, candidate, { required });
        };

        const preResolved = req.resolveAuthorizedUserFromRequest({ required: false, candidateKeys: defaultCandidateKeys });
        req.authorizedUserResolution = preResolved;
        req.authorizedUser = preResolved && !preResolved.error
            ? normalizeUserCandidate(preResolved.user)
            : '';

        next();
    };

    const requireAuthorizedUser = (options = {}) => {
        return (req, res, next) => {
            const candidateKeys = Array.isArray(options.candidateKeys) && options.candidateKeys.length
                ? options.candidateKeys
                : defaultCandidateKeys;
            const resolution = req.resolveAuthorizedUserFromRequest({
                required: options.required !== false,
                candidateKeys
            });
            req.authorizedUserResolution = resolution;
            req.authorizedUser = resolution && !resolution.error
                ? normalizeUserCandidate(resolution.user)
                : '';
            req.resolvedUser = req.authorizedUser;

            if (resolution && resolution.error) {
                if (typeof options.onError === 'function') {
                    return options.onError(req, res, resolution);
                }
                return res.status(resolution.status || 400).json({ error: resolution.error });
            }

            return next();
        };
    };

    return {
        attachResolvedUser,
        requireAuthorizedUser
    };
}

module.exports = {
    createAuthorizedUserMiddleware
};
