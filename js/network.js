(() => {
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  
    const shouldRetry = (status) => {
      if (!status) return true;
      return status >= 500 || status === 429;
    };
  
    const fetchWithRetry = async (url, options = {}, retryOptions = {}) => {
      const {
        retries = 2,
        timeoutMs = 10000,
        backoffMs = 500
      } = retryOptions;
  
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        try {
          const response = await fetch(url, {
            ...options,
            signal: controller ? controller.signal : undefined
          });
  
          if (!response.ok && attempt < retries && shouldRetry(response.status)) {
            await sleep(backoffMs * Math.pow(2, attempt));
            continue;
          }
          return response;
        } catch (error) {
          lastError = error;
          if (attempt < retries) {
            await sleep(backoffMs * Math.pow(2, attempt));
            continue;
          }
          throw error;
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      }
      throw lastError;
    };
  
    window.fetchWithRetry = fetchWithRetry;
    window.networkSleep = sleep;
  })();