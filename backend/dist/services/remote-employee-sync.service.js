"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteEmployeeSyncService = void 0;
exports.fetchRemoteUserDetails = fetchRemoteUserDetails;
exports.syncRemoteUserIntoSubscribeTable = syncRemoteUserIntoSubscribeTable;
exports.createRemoteEmployeeSyncServiceFromEnv = createRemoteEmployeeSyncServiceFromEnv;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_url_1 = require("node:url");
const mssql = __importStar(require("mssql"));
const auth_sms_service_1 = require("./auth-sms.service");
function toTrimmedString(value) {
    return String(value ?? '').trim();
}
function uniqueValues(values) {
    return Array.from(new Set(values.map((value) => toTrimmedString(value)).filter(Boolean)));
}
function buildRemoteLookupCandidates(value) {
    const raw = toTrimmedString(value);
    if (!raw)
        return [];
    const digits = raw.replace(/\D/g, '');
    const localPhone = (0, auth_sms_service_1.normalizeIsraeliPhoneNumberToLocal)(raw);
    const localPhoneWithoutLeadingZero = localPhone ? localPhone.replace(/^0/, '') : '';
    const internationalPhone = digits && /^0?\d{9}$/.test(digits) ? `972${digits.replace(/^0/, '')}` : '';
    return uniqueValues([
        raw,
        raw.toLowerCase(),
        digits,
        digits.startsWith('0') ? digits.slice(1) : '',
        localPhone,
        localPhoneWithoutLeadingZero,
        internationalPhone,
    ]);
}
function buildFullName(row) {
    const baseFullName = toTrimmedString(row.BaseFullName);
    const sector = toTrimmedString(row.EmployeeSektorDescription);
    const functionDescription = toTrimmedString(row.FunctionDescription);
    return `${baseFullName || ''} (${sector}  -  ${functionDescription})`.trim();
}
function normalizeYearOfBirth(value) {
    const raw = toTrimmedString(value);
    if (!raw)
        return '';
    const year = raw.match(/\b(\d{4})\b/);
    return year ? year[1] : raw;
}
function normalizeProfilePictureBaseUrl(rawBaseUrl) {
    const trimmed = toTrimmedString(rawBaseUrl);
    if (!trimmed)
        return '';
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}
function inferFileExtension(source, contentType) {
    const normalizedContentType = toTrimmedString(contentType).toLowerCase();
    const contentTypeMap = {
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/bmp': '.bmp',
        'image/x-ms-bmp': '.bmp',
        'image/avif': '.avif',
        'image/heic': '.heic',
        'image/heif': '.heif',
    };
    if (contentTypeMap[normalizedContentType]) {
        return contentTypeMap[normalizedContentType];
    }
    const parsedPath = source.startsWith('file://')
        ? (0, node_url_1.fileURLToPath)(source)
        : source;
    const ext = node_path_1.default.extname(parsedPath).toLowerCase();
    return ext || '.jpg';
}
function sanitizeFileStem(rawValue) {
    const trimmed = toTrimmedString(rawValue);
    if (!trimmed)
        return 'user';
    return trimmed
        .normalize('NFC')
        .replace(/[\u0000-\u001f\u007f]+/gu, '')
        .replace(/[^\p{L}\p{N}._\- ]+/gu, '-')
        .replace(/-+/g, '-')
        .replace(/^[._\- ]+/, '')
        .replace(/[._\- ]+$/, '')
        .slice(0, 64) || 'user';
}
async function readRemoteProfilePictureBuffer(source) {
    const normalizedSource = toTrimmedString(source);
    if (!normalizedSource)
        return null;
    if (/^file:\/\//i.test(normalizedSource)) {
        const filePath = (0, node_url_1.fileURLToPath)(normalizedSource);
        return { buffer: await promises_1.default.readFile(filePath), contentType: '' };
    }
    if (/^https?:\/\//i.test(normalizedSource)) {
        const response = await fetch(normalizedSource);
        if (!response.ok) {
            return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        return {
            buffer: Buffer.from(arrayBuffer),
            contentType: response.headers.get('content-type') || ''
        };
    }
    if (node_path_1.default.isAbsolute(normalizedSource) || normalizedSource.startsWith('.')) {
        return { buffer: await promises_1.default.readFile(normalizedSource), contentType: '' };
    }
    return null;
}
async function downloadRemoteProfilePicture({ profilePicturePath, profilePictureBaseUrl, uploadDir, username, usersUploadSubdirectory = 'users', publicUploadBasePath = '/notify/uploads/users', }) {
    const source = toTrimmedString(profilePicturePath);
    if (!source)
        return '';
    const baseUrl = normalizeProfilePictureBaseUrl(profilePictureBaseUrl || '');
    let resolvedSource = source;
    if (!/^https?:\/\//i.test(source) && !/^file:\/\//i.test(source) && baseUrl) {
        try {
            resolvedSource = new URL(source.replace(/^\/+/, ''), baseUrl).toString();
        }
        catch {
            resolvedSource = source;
        }
    }
    const payload = await readRemoteProfilePictureBuffer(resolvedSource);
    if (!payload || !payload.buffer.length) {
        return '';
    }
    const safeStem = sanitizeFileStem(username || node_path_1.default.basename(source));
    const extension = inferFileExtension(resolvedSource, payload.contentType);
    const filename = `${Date.now()}-${node_crypto_1.default.randomBytes(4).toString('hex')}-${safeStem}${extension}`;
    const targetDir = node_path_1.default.join(uploadDir, usersUploadSubdirectory);
    await promises_1.default.mkdir(targetDir, { recursive: true });
    await promises_1.default.writeFile(node_path_1.default.join(targetDir, filename), payload.buffer);
    return `${publicUploadBasePath.replace(/\/+$/, '')}/${encodeURIComponent(filename)}`;
}
async function fetchRemoteUserDetails(mssqlPool, usernameOrPhone) {
    const candidates = buildRemoteLookupCandidates(usernameOrPhone);
    if (!candidates.length)
        return null;
    const query = `
    SELECT
      ep.[FirstName] + ' ' + ep.[LastName] AS BaseFullName,
      ep.[ProfilePicture] AS ProfilePicture,
      epd.DepartnentDescripton AS EmployeeSektorDescription,
      epf.FunctionDescription,
      ep.[ADUserName] AS UserName,
      FORMAT(ep.DateOfBirth, 'yyyy') AS YearOfBirth
    FROM [NAMER].[dbo].EP_Employees ep WITH (NOLOCK)
      LEFT JOIN [NAMER].[dbo].[EP_Departnents] epd WITH (NOLOCK)
        ON ep.DepartnentCode = epd.DepartnentCode
      LEFT JOIN [NAMER].[dbo].[EP_EmployeeSektors] eps WITH (NOLOCK)
        ON ep.EmployeeSektorID = eps.EmployeeSektorID
      LEFT JOIN [NAMER].[dbo].[EP_Functions] epf WITH (NOLOCK)
        ON ep.FunctionID = epf.FunctionID
    WHERE (
      LOWER(ep.[ADUserName]) = LOWER(@u)
      OR (
        TRY_CAST(@u AS BIGINT) IS NOT NULL
        AND (ep.[CellNumber] = '0' + @u OR ep.[CellNumber] = @u)
      )
    )
    AND ep.EndWorkDate IS NULL;
  `;
    for (const candidate of candidates) {
        const request = mssqlPool.request();
        request.input('u', mssql.NVarChar, candidate);
        const result = await request.query(query);
        if (!result.recordset || result.recordset.length === 0) {
            continue;
        }
        const row = result.recordset[0];
        return {
            fullName: buildFullName(row),
            profilePicturePath: toTrimmedString(row.ProfilePicture),
            yearOfBirth: normalizeYearOfBirth(row.YearOfBirth),
            userName: toTrimmedString(row.UserName),
        };
    }
    return null;
}
async function syncRemoteUserIntoSubscribeTable({ mysqlPool, remotePool, usernameOrPhone, uploadDir, profilePictureBaseUrl, usersUploadSubdirectory = 'users', publicUploadBasePath = '/notify/uploads/users', }) {
    const remoteDetails = await fetchRemoteUserDetails(remotePool, usernameOrPhone);
    if (!remoteDetails) {
        return null;
    }
    const requestedUser = toTrimmedString(usernameOrPhone);
    const matchedUserCandidates = uniqueValues([
        requestedUser,
        requestedUser.toLowerCase(),
        remoteDetails.userName,
        remoteDetails.userName.toLowerCase(),
    ]);
    const matchedUser = matchedUserCandidates[0] || '';
    if (!matchedUser) {
        return null;
    }
    let localProfilePicture = '';
    try {
        localProfilePicture = await downloadRemoteProfilePicture({
            profilePicturePath: remoteDetails.profilePicturePath,
            profilePictureBaseUrl,
            uploadDir,
            username: matchedUser,
            usersUploadSubdirectory,
            publicUploadBasePath,
        });
    }
    catch {
        localProfilePicture = '';
    }
    const upicValue = localProfilePicture || null;
    const fullNameValue = remoteDetails.fullName || null;
    const yearOfBirthValue = remoteDetails.yearOfBirth || null;
    const userNameValue = remoteDetails.userName || null;
    const [existingRows] = await mysqlPool.query(`SELECT \`User\` FROM \`Subscribe\`
     WHERE \`User\` IN (?) OR \`UserName\` IN (?)
     ORDER BY CASE WHEN \`User\` IN (?) THEN 0 ELSE 1 END, \`UpdatedAt\` DESC, \`RowID\` DESC
     LIMIT 1`, [matchedUserCandidates, matchedUserCandidates, matchedUserCandidates]);
    const currentUser = existingRows && existingRows.length > 0
        ? toTrimmedString(existingRows[0].User)
        : matchedUser;
    if (!currentUser) {
        return null;
    }
    if (existingRows && existingRows.length > 0) {
        await mysqlPool.execute(`UPDATE \`Subscribe\`
       SET
         \`FullName\` = COALESCE(NULLIF(?, ''), \`FullName\`),
         \`YearOfBirth\` = COALESCE(NULLIF(?, ''), \`YearOfBirth\`),
         \`UserName\` = COALESCE(NULLIF(?, ''), \`UserName\`),
         \`Upic\` = COALESCE(NULLIF(?, ''), \`Upic\`),
         \`DateTimeRegistration\` = COALESCE(\`DateTimeRegistration\`, NOW()),
         \`Staus\` = COALESCE(NULLIF(\`Staus\`, ''), '0'),
         \`ExeptionStatus\` = COALESCE(NULLIF(\`ExeptionStatus\`, ''), '0'),
         \`UpdatedAt\` = NOW()
       WHERE \`User\` = ? OR \`UserName\` = ?`, [fullNameValue, yearOfBirthValue, userNameValue, upicValue, currentUser, remoteDetails.userName || currentUser]);
    }
    else {
        await mysqlPool.execute(`INSERT INTO \`Subscribe\`
       (\`DateTimeRegistration\`, \`User\`, \`PushType\`, \`AuthJson\`, \`AuthJsonPc\`, \`FullName\`, \`Staus\`, \`ExeptionStatus\`, \`ExeptionName\`, \`Upic\`, \`YearOfBirth\`, \`UserName\`, \`UpdatedAt\`)
       VALUES (NOW(), ?, NULL, NULL, NULL, ?, '0', '0', NULL, ?, ?, ?, NOW())`, [
            currentUser,
            fullNameValue,
            upicValue,
            yearOfBirthValue,
            userNameValue,
        ]);
    }
    return {
        user: currentUser,
        fullName: remoteDetails.fullName,
        profilePicturePath: remoteDetails.profilePicturePath,
        yearOfBirth: remoteDetails.yearOfBirth,
        userName: remoteDetails.userName,
        upic: localProfilePicture,
    };
}
class RemoteEmployeeSyncService {
    mysqlPool;
    remoteConfig;
    remotePoolPromise = null;
    constructor(config) {
        this.mysqlPool = config.mysqlPool;
        this.remoteConfig = config;
    }
    async getRemotePool() {
        if (!this.remotePoolPromise) {
            const pool = new mssql.ConnectionPool({
                server: this.remoteConfig.server,
                user: this.remoteConfig.user,
                password: this.remoteConfig.password,
                database: this.remoteConfig.database,
                port: this.remoteConfig.port ?? 1433,
                requestTimeout: this.remoteConfig.requestTimeout ?? 300000,
                options: {
                    enableArithAbort: true,
                    encrypt: true,
                    trustServerCertificate: true,
                },
            });
            this.remotePoolPromise = pool.connect();
        }
        return this.remotePoolPromise;
    }
    async syncUser(usernameOrPhone) {
        const remotePool = await this.getRemotePool();
        return syncRemoteUserIntoSubscribeTable({
            mysqlPool: this.mysqlPool,
            remotePool,
            usernameOrPhone,
            uploadDir: this.remoteConfig.uploadDir,
            profilePictureBaseUrl: this.remoteConfig.profilePictureBaseUrl,
            usersUploadSubdirectory: this.remoteConfig.usersUploadSubdirectory,
            publicUploadBasePath: this.remoteConfig.publicUploadBasePath,
        });
    }
}
exports.RemoteEmployeeSyncService = RemoteEmployeeSyncService;
function createRemoteEmployeeSyncServiceFromEnv(env, mysqlPool, uploadDir) {
    const server = toTrimmedString(env.REMOTE_EMPLOYEE_DB_SERVER);
    const user = toTrimmedString(env.REMOTE_EMPLOYEE_DB_USER);
    const password = toTrimmedString(env.REMOTE_EMPLOYEE_DB_PASSWORD);
    const database = toTrimmedString(env.REMOTE_EMPLOYEE_DB_DATABASE || env.REMOTE_EMPLOYEE_DB_NAME);
    if (!server || !user || !password || !database) {
        return null;
    }
    const port = Number(env.REMOTE_EMPLOYEE_DB_PORT || 1433);
    const requestTimeout = Number(env.REMOTE_EMPLOYEE_DB_REQUEST_TIMEOUT || 300000);
    return new RemoteEmployeeSyncService({
        mysqlPool,
        server,
        user,
        password,
        database,
        port: Number.isFinite(port) && port > 0 ? Math.floor(port) : 1433,
        requestTimeout: Number.isFinite(requestTimeout) && requestTimeout > 0 ? Math.floor(requestTimeout) : 300000,
        profilePictureBaseUrl: toTrimmedString(env.REMOTE_EMPLOYEE_PROFILE_PICTURE_BASE_URL),
        uploadDir,
        usersUploadSubdirectory: toTrimmedString(env.REMOTE_EMPLOYEE_PROFILE_PICTURE_USERS_SUBDIRECTORY) || 'users',
        publicUploadBasePath: toTrimmedString(env.REMOTE_EMPLOYEE_PROFILE_PICTURE_PUBLIC_BASE_PATH) || '/notify/uploads/users',
    });
}
