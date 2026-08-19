const path = require('path');

function normalizeCandidateName(rawValue) {
    const trimmed = String(rawValue || '')
        .replace(/[\u0000-\u001f\u007f]+/g, '')
        .trim();
    if (!trimmed) {
        return '';
    }
    const baseName = path.basename(trimmed);
    if (!baseName || baseName === '.' || baseName === '..') {
        return '';
    }
    const stem = String(path.parse(baseName).name || '').trim();
    if (!stem || stem === '.' || stem === '..') {
        return '';
    }
    return stem;
}

function extractUsersUploadIdentityCandidatesFromFiles(files) {
    const fileList = Array.isArray(files) ? files : [files];
    const candidates = new Set();
    fileList.forEach((file) => {
        if (!file || typeof file !== 'object') {
            return;
        }
        [file.originalname, file.filename].forEach((value) => {
            const candidate = normalizeCandidateName(value);
            if (candidate) {
                candidates.add(candidate);
            }
        });
    });
    return Array.from(candidates);
}

module.exports = {
    extractUsersUploadIdentityCandidatesFromFiles
};
