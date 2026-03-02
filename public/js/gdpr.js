// Modern notification system - replace alerts with notifications
function showNotification(message, type = 'info') {
    // Truncate very long messages but preserve important info
    let displayMessage = String(message || '');
    if (displayMessage.length > 500) {
        const lines = displayMessage.split('\n');
        if (lines.length > 3) {
            displayMessage = lines.slice(0, 3).join('\n') + '\n... (se konsollen for fuld besked)';
        } else {
            displayMessage = displayMessage.substring(0, 500) + '... (se konsollen for fuld besked)';
        }
    }
    
    let container = document.getElementById('notifications');
    if (!container) {
        container = document.createElement('div');
        container.id = 'notifications';
        container.style.cssText = `
            position: fixed;
            top: var(--space-lg);
            right: var(--space-lg);
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: var(--space-sm);
            max-width: 400px;
            pointer-events: none;
        `;
        document.body.appendChild(container);
    }
    
    const notification = document.createElement('div');
    notification.className = `alert alert-${type === 'error' ? 'error' : type === 'success' ? 'success' : 'info'}`;
    notification.style.cssText = `
        min-width: 300px;
        padding: var(--space-md);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        animation: slideIn 0.3s ease-out;
        cursor: pointer;
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: var(--space-sm);
    `;
    
    const icon = type === 'error' ? '⚠️' : type === 'success' ? '✓' : 'ℹ️';
    notification.innerHTML = `
        <span style="font-size: 1.2em;">${icon}</span>
        <span style="flex: 1; white-space: pre-wrap; word-wrap: break-word;">${displayMessage}</span>
        <button style="background: transparent; border: none; cursor: pointer; font-size: 1.2em; padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;" onclick="this.parentElement.remove()">×</button>
    `;
    
    notification.addEventListener('click', (e) => {
        if (e.target.tagName !== 'BUTTON' && !e.target.closest('button')) {
            notification.style.animation = 'slideOut 0.2s ease-in';
            setTimeout(() => notification.remove(), 200);
        }
    });
    
    container.appendChild(notification);
    
    if (type !== 'error') {
        setTimeout(() => {
            if (notification.parentElement) {
                notification.style.animation = 'slideOut 0.3s ease-in';
                setTimeout(() => notification.remove(), 300);
            }
        }, 5000);
    }
}

function showError(message) {
    showNotification(message, 'error');
}

function showSuccess(message) {
    showNotification(message, 'success');
}

function showInfo(message) {
    showNotification(message, 'info');
}

// Add CSS animations if not already present
if (!document.getElementById('notification-styles')) {
    const style = document.createElement('style');
    style.id = 'notification-styles';
    style.textContent = `
        @keyframes slideIn {
            from {
                transform: translateX(100%);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
        @keyframes slideOut {
            from {
                transform: translateX(0);
                opacity: 1;
            }
            to {
                transform: translateX(100%);
                opacity: 0;
            }
        }
    `;
    document.head.appendChild(style);
}

const hearingListEl = document.getElementById('hearing-list');
const detailEl = document.getElementById('gdpr-detail');
const hearingCountEl = document.getElementById('hearing-count');
const searchInput = document.getElementById('hearing-search');

// Auto-resize textarea to fit content
function autoResizeTextarea(textarea) {
    if (!textarea) return;
    // Reset height to allow shrinking
    textarea.style.height = 'auto';
    // Set height to scrollHeight, but respect min/max from CSS
    const minHeight = 120;
    const maxHeight = 600;
    const scrollH = textarea.scrollHeight;
    // Only resize if we have actual content height
    if (scrollH > 0) {
        const newHeight = Math.min(Math.max(scrollH, minHeight), maxHeight);
        textarea.style.height = newHeight + 'px';
    }
}

// Setup auto-resize listeners for a textarea
function setupTextareaAutoResize(textarea) {
    if (!textarea || textarea.dataset.autoResizeSetup) return;
    textarea.dataset.autoResizeSetup = 'true';
    textarea.addEventListener('input', () => autoResizeTextarea(textarea));
    // Multiple attempts to resize after rendering
    requestAnimationFrame(() => autoResizeTextarea(textarea));
    setTimeout(() => autoResizeTextarea(textarea), 50);
    setTimeout(() => autoResizeTextarea(textarea), 150);
}

const templates = {
    rawResponse: document.getElementById('raw-response-template'),
    preparedResponse: document.getElementById('prepared-response-template'),
    attachment: document.getElementById('attachment-template'),
    material: document.getElementById('material-template')
};

const state = {
    hearings: [],
    currentId: null,
    detail: null,
    loading: false,
    searchTerm: '',
    filters: {},
    filterPendingActive: false,
    // Pagination state
    pagination: {
        page: 1,
        pageSize: 50,
        pendingOnly: true,  // Default: show only non-approved
        search: '',
        totalResponses: 0,
        totalPages: 0
    },
    counts: null  // Response counts (total, approved, pending)
};

// Load saved hearings from server (global)
async function loadSavedHearings() {
    try {
        const data = await fetchJson('/api/gdpr/selected-hearings');
        if (data && Array.isArray(data.hearings)) {
            state.hearings = data.hearings;
            return true;
        }
    } catch (e) {
        console.error('Kunne ikke loade gemte høringer', e);
    }
    return false;
}

// Save hearing to server (global) - adds hearing to selected list
async function saveHearingToServer(hearingId) {
    try {
        await fetchJson(`/api/gdpr/selected-hearings/${hearingId}`, {
            method: 'POST'
        });
        return true;
    } catch (e) {
        console.error('Kunne ikke gemme høring', e);
        return false;
    }
}

// Remove hearing from server (global) - removes hearing from selected list
async function removeHearingFromServer(hearingId) {
    try {
        await fetchJson(`/api/gdpr/selected-hearings/${hearingId}`, {
            method: 'DELETE'
        });
        return true;
    } catch (e) {
        console.error('Kunne ikke fjerne høring', e);
        return false;
    }
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
        const message = data.error || data.message || response.statusText;
        throw new Error(message || 'Ukendt fejl');
    }
    return data;
}

function formatStatusPill(status) {
    const normalized = String(status || 'draft').toLowerCase();
    if (normalized === 'published') return { text: 'Publiceret', className: 'status-pill ready' };
    if (normalized === 'ready') return { text: 'Klar til publicering', className: 'status-pill ready' };
    if (normalized === 'in-progress') return { text: 'I arbejde', className: 'status-pill progress' };
    return { text: 'Klargøring mangler', className: 'status-pill draft' };
}

function setLoading(flag) {
    state.loading = flag;
    if (flag) detailEl.classList.add('is-loading');
    else detailEl.classList.remove('is-loading');
}

function showLoadingIndicator(steps) {
    const loadingId = 'hearing-loading-indicator';
    let loadingEl = document.getElementById(loadingId);
    
    if (!loadingEl) {
        loadingEl = document.createElement('div');
        loadingEl.id = loadingId;
        loadingEl.className = 'step-loading-indicator';
        detailEl.innerHTML = '';
        detailEl.appendChild(loadingEl);
    }
    
    const currentStep = steps.current || 0;
    const totalSteps = steps.total || steps.steps?.length || 3;
    const stepTexts = steps.steps || ['Henter høringsdata...', 'Henter svar...', 'Indlæser...'];
    const progressText = steps.progressText || '';
    
    // Check if we're just updating progress text (not changing steps)
    const progressTextEl = loadingEl.querySelector('.progress-text');
    if (progressTextEl && progressText) {
        // Just update the progress text without re-rendering everything
        progressTextEl.textContent = progressText;
        return;
    }
    
    // Full re-render only when steps change
    loadingEl.innerHTML = `
        <div class="loading-content">
            <div class="loading-spinner-pulse"></div>
            <div class="loading-steps">
                ${stepTexts.map((text, idx) => {
                    const isActive = idx === currentStep;
                    return `
                        <div class="loading-step ${isActive ? 'active' : idx < currentStep ? 'completed' : ''}">
                            <span class="step-indicator">${idx < currentStep ? '✓' : idx + 1}</span>
                            <span class="step-text">${text}<span class="progress-text">${isActive && progressText ? ` ${progressText}` : ''}</span></span>
                        </div>
                    `;
                }).join('')}
            </div>
            <div class="loading-progress">
                <div class="loading-progress-bar" style="width: ${((currentStep + 1) / totalSteps) * 100}%"></div>
            </div>
        </div>
    `;
}

let refreshProgressInterval = null;
let lastResponseCount = 0;
let refreshStartTime = null;
let estimatedTotalPages = 3; // Default estimate

function startRefreshProgressTracking(hearingId) {
    if (refreshProgressInterval) clearInterval(refreshProgressInterval);
    
    lastResponseCount = 0;
    refreshStartTime = Date.now();
    estimatedTotalPages = 3; // Reset estimate
    
    // Start showing progress immediately
    showLoadingIndicator({
        steps: ['Henter høringsdata...', 'Henter svar...', 'Indlæser...'],
        current: 1,
        total: 3,
        progressText: '(side 1)'
    });
    
    refreshProgressInterval = setInterval(() => {
        const elapsed = Date.now() - refreshStartTime;
        
        // Estimate page based on elapsed time
        // Based on terminal logs: pages fetch in ~0.1-0.2 seconds each
        // Page 1: ~0s, Page 2: ~0.2s, Page 3: ~0.4s, etc.
        // But we'll be more conservative and show progress faster
        let estimatedPage = 1;
        if (elapsed >= 0) {
            // More aggressive: show page based on elapsed time
            // After 0.2s = page 2, after 0.4s = page 3, etc.
            estimatedPage = Math.max(1, Math.floor(elapsed / 200) + 1);
            // Cap at reasonable max
            estimatedPage = Math.min(estimatedPage, 20);
        }
        
        // Update progress text without re-rendering everything
        const loadingEl = document.getElementById('hearing-loading-indicator');
        if (loadingEl) {
            const progressTextEl = loadingEl.querySelector('.progress-text');
            if (progressTextEl) {
                progressTextEl.textContent = `(side ${estimatedPage})`;
            } else {
                // Fallback to full update if element not found
                showLoadingIndicator({
                    steps: ['Henter høringsdata...', 'Henter svar...', 'Indlæser...'],
                    current: 1,
                    total: 3,
                    progressText: `(side ${estimatedPage})`
                });
            }
        }
        
        // Also try to get actual response count as backup (less frequently)
        if (elapsed % 1000 < 500) { // Only check every ~1 second
            fetchJson(`/api/gdpr/hearing/${hearingId}`).then(data => {
                if (data && data.raw && Array.isArray(data.raw.responses)) {
                    const responseCount = data.raw.responses.length;
                    if (responseCount > 0 && responseCount !== lastResponseCount) {
                        lastResponseCount = responseCount;
                        // If we have actual responses, use that instead
                        const actualPage = Math.ceil(responseCount / 20);
                        const loadingEl = document.getElementById('hearing-loading-indicator');
                        if (loadingEl) {
                            const progressTextEl = loadingEl.querySelector('.progress-text');
                            if (progressTextEl && actualPage > 0) {
                                progressTextEl.textContent = `(side ${actualPage})`;
                            }
                        }
                    }
                }
            }).catch(() => {
                // If API call fails, we already showed time-based estimate above
            });
        }
    }, 500); // Update every 500ms instead of 200ms for smoother animation
}

function stopRefreshProgressTracking() {
    if (refreshProgressInterval) {
        clearInterval(refreshProgressInterval);
        refreshProgressInterval = null;
    }
    lastResponseCount = 0;
    refreshStartTime = null;
    estimatedTotalPages = 3;
}

function hideLoadingIndicator() {
    stopRefreshProgressTracking();
    const loadingEl = document.getElementById('hearing-loading-indicator');
    if (loadingEl) {
        loadingEl.remove();
    }
}

function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateDisplay(value) {
    const date = parseDate(value);
    if (!date) return value || 'ukendt';
    return date.toLocaleDateString('da-DK', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDeadlineShort(value) {
    const date = parseDate(value);
    if (!date) return 'Ingen frist';
    return date.toLocaleDateString('da-DK', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDeadline(value) {
    return value ? formatDeadlineShort(value) : 'ukendt';
}

if (searchInput) {
    searchInput.addEventListener('input', (event) => {
        state.searchTerm = event.target.value || '';
        renderHearingList();
    });
    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            state.searchTerm = '';
            event.target.value = '';
            renderHearingList();
            event.target.blur();
        }
    });
}

async function loadHearings() {
    try {
        // Use selected-hearings endpoint for consistency
        const data = await fetchJson('/api/gdpr/selected-hearings');
        state.hearings = data.hearings || [];
        renderHearingList();
    } catch (error) {
        console.error('Kunne ikke hente hearings', error);
        hearingListEl.innerHTML = `<div class="list-empty">Fejl: ${error.message}</div>`;
    }
}

async function addOrUpdateHearingInList(hearingId) {
    try {
        // Fetch hearing detail to get metadata for the list
        const data = await fetchJson(`/api/gdpr/hearing/${hearingId}`);
        if (!data || !data.hearing) return;
        
        const hearing = data.hearing;
        const hearingItem = {
            hearingId: Number(hearing.id || hearingId),
            id: Number(hearing.id || hearingId),
            title: hearing.title || `Høring ${hearingId}`,
            deadline: hearing.deadline || null,
            status: hearing.status || 'ukendt',
            preparation: {
                status: data.state?.status || 'draft',
                responsesReady: data.state?.responses_ready || false,
                materialsReady: data.state?.materials_ready || false
            },
            counts: {
                rawResponses: data.raw?.responses?.length || 0,
                preparedResponses: data.prepared?.responses?.length || 0,
                publishedResponses: data.published?.responses?.length || 0
            }
        };
        
        // Find existing hearing in list
        const existingIndex = state.hearings.findIndex(h => Number(h.hearingId) === Number(hearingId));
        if (existingIndex >= 0) {
            // Update existing but preserve isLoading if it was set
            const wasLoading = state.hearings[existingIndex].isLoading === true;
            state.hearings[existingIndex] = hearingItem;
            // Only remove loading if we have actual data
            if (hearingItem.counts && hearingItem.counts.rawResponses > 0) {
                state.hearings[existingIndex].isLoading = false;
            }
        } else {
            // Add new - save to server
            state.hearings.push(hearingItem);
            await saveHearingToServer(hearingId);
        }
        
        renderHearingList();
    } catch (error) {
        console.error('Kunne ikke opdatere høring i listen', error);
        // Don't fall back to loading all hearings - just log the error
        // The hearing detail will still be loaded via selectHearing()
    }
}

function renderHearingList() {
    const total = state.hearings.length;
    const term = (state.searchTerm || '').trim().toLowerCase();
    const filtered = !term ? state.hearings : state.hearings.filter((hearing) => {
        const title = String(hearing.title || '').toLowerCase();
        const idMatch = String(hearing.hearingId || hearing.id || '').includes(term);
        const statusText = String(hearing.status || '').toLowerCase();
        return title.includes(term) || idMatch || statusText.includes(term);
    });
    const count = filtered.length;
    if (hearingCountEl) {
        hearingCountEl.textContent = count;
        hearingCountEl.title = count === total
            ? `Viser ${total} høringer`
            : `Viser ${count} af ${total} høringer`;
    }
    if (!count) {
        hearingListEl.innerHTML = state.searchTerm
            ? '<div class="list-empty">Ingen høringer matcher din søgning</div>'
            : '<div class="list-empty">Ingen høringer fundet</div>';
        return;
    }
    hearingListEl.innerHTML = '';
    const fragment = document.createDocumentFragment();
    let activeItem = null;
    for (const hearing of filtered) {
        const item = document.createElement('div');
        item.className = 'hearing-item';
        if (Number(state.currentId) === Number(hearing.hearingId)) {
            item.classList.add('active');
            activeItem = item;
        }
        const statusPill = formatStatusPill(hearing.preparation?.status);
        const rawCount = hearing.counts?.rawResponses ?? 0;
        const preparedCount = hearing.counts?.preparedResponses ?? 0;
        const publishedCount = hearing.counts?.publishedResponses ?? 0;
        const isLoading = hearing.isLoading === true;
        item.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:4px;">
                <div style="display:flex;align-items:center;gap:var(--space-xs);">
                    <strong>${hearing.title || `Høring ${hearing.hearingId}`}</strong>
                    ${isLoading ? '<div class="loading-spinner" style="width:14px;height:14px;border-width:2px;"></div>' : ''}
                </div>
                <div style="display:flex;flex-direction:column;gap:2px;font-size:var(--font-size-sm);color:var(--color-gray-600);">
                    <span>Deadline: ${formatDeadline(hearing.deadline)}</span>
                </div>
                <div class="pill-group">
                    ${isLoading ? '<span class="status-pill progress">Henter...</span>' : `<span class="${statusPill.className}">${statusPill.text}</span>`}
                    ${!isLoading && hearing.preparation?.responsesReady ? '<span class="status-pill ready">Svar klar</span>' : ''}
                    ${!isLoading && hearing.preparation?.materialsReady ? '<span class="status-pill ready">Materiale klar</span>' : ''}
                </div>
            </div>
        `;
        item.dataset.hearingId = hearing.hearingId;
        fragment.appendChild(item);
    }
    hearingListEl.appendChild(fragment);
    
    // Auto-scroll to active hearing if not visible
    if (activeItem) {
        const container = hearingListEl;
        const itemRect = activeItem.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        
        // Check if item is not fully visible
        if (itemRect.top < containerRect.top || itemRect.bottom > containerRect.bottom) {
            activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}

async function selectHearing(hearingId) {
    if (!hearingId) return;
    state.currentId = hearingId;
    // Reset filter and pagination when switching hearings
    state.filterPendingActive = false;
    state.pagination = {
        page: 1,
        pageSize: 50,
        pendingOnly: true,  // Default: show only non-approved
        search: '',
        totalResponses: 0,
        totalPages: 0
    };
    state.counts = null;
    renderHearingList();
    await loadHearingDetail(hearingId);
}

async function loadHearingDetail(hearingId, options = {}) {
    setLoading(true);
    try {
        // Build query params for pagination
        const params = new URLSearchParams();
        const page = options.page ?? state.pagination.page;
        const pageSize = options.pageSize ?? state.pagination.pageSize;
        const pendingOnly = options.pendingOnly ?? state.pagination.pendingOnly;
        const search = options.search ?? state.pagination.search;
        
        params.set('page', page);
        params.set('pageSize', pageSize);
        params.set('pendingOnly', pendingOnly);
        if (search) params.set('search', search);
        
        const data = await fetchJson(`/api/gdpr/hearing/${hearingId}?${params.toString()}`);
        state.detail = data;
        
        // Update pagination state from response
        if (data.pagination) {
            state.pagination = {
                page: data.pagination.page,
                pageSize: data.pagination.pageSize,
                pendingOnly: data.pagination.pendingOnly,
                search: data.pagination.search || '',
                totalResponses: data.pagination.totalResponses,
                totalPages: data.pagination.totalPages
            };
        }
        
        // Update counts
        if (data.counts) {
            state.counts = data.counts;
        }
        
        renderHearingDetail();
    } catch (error) {
        console.error('Kunne ikke hente detaljer', error);
        detailEl.innerHTML = `<div class="detail-section"><h2>Fejl</h2><p>${error.message}</p></div>`;
    } finally {
        setLoading(false);
    }
}

function createCardFromTemplate(selector) {
    const tpl = templates[selector];
    return tpl ? tpl.content.firstElementChild.cloneNode(true) : document.createElement('div');
}

function renderStateSection(detail) {
    const status = formatStatusPill(detail.state?.status);
    const responsesReady = detail.state?.responses_ready || detail.state?.responsesReady;
    const materialsReady = detail.state?.materials_ready || detail.state?.materialsReady;
    const publishedAt = detail.state?.published_at || detail.state?.publishedAt;
    
    // Use state.counts from API (includes totals, not just paginated subset)
    const apiCounts = state.counts || {};
    const counts = {
        raw: apiCounts.raw || apiCounts.total || detail.raw?.responses?.length || 0,
        prepared: apiCounts.total || detail.prepared?.responses?.length || 0,
        published: apiCounts.published || detail.published?.responses?.length || 0,
        approved: apiCounts.approved || (detail.prepared?.responses || []).filter(r => r.approved).length,
        pending: apiCounts.pending || 0
    };
    const materialsCount = {
        raw: detail.raw?.materials?.length || 0,
        prepared: detail.prepared?.materials?.length || 0,
        published: detail.published?.materials?.length || 0,
        approved: (detail.prepared?.materials || []).filter(m => m.approved).length
    };
    return `
        <div class="detail-section" data-role="state" style="position:relative;">
            <button id="hearing-actions-btn" class="btn btn-ghost btn-icon" style="position:absolute;top:var(--space-md);right:var(--space-md);z-index:10;" title="Hørings-handlinger">
                <svg class="icon" style="width:20px;height:20px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="5" r="1"></circle>
                    <circle cx="12" cy="12" r="1"></circle>
                    <circle cx="12" cy="19" r="1"></circle>
                </svg>
            </button>
            <div id="hearing-actions-menu" class="actions-menu" style="display:none;">
                <button class="menu-item" data-action="refresh-raw">
                    <span>Opdater fra blivhørt</span>
                    <span class="menu-item-desc">Henter høringssvar og konverterer vedhæftninger</span>
                </button>
                <button class="menu-item" data-action="reset-hearing">
                    <span>Fuld nulstil</span>
                    <span class="menu-item-desc">Nulstiller alle klargjorte svar og materiale</span>
                </button>
                <button class="menu-item menu-item-danger" data-action="delete-hearing">
                    <span>Slet høring</span>
                    <span class="menu-item-desc">Sletter alle data for denne høring</span>
                </button>
            </div>
            <h2>${detail.hearing?.title || `Høring ${detail.hearing?.id}`}</h2>
            <div style="display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap;">
                <span class="${status.className}">${status.text}</span>
                <span class="status-pill ${counts.approved === counts.raw && counts.raw > 0 ? 'ready' : 'progress'}" title="Godkendte svar er klar til publicering. Rå svar er de originale fra blivhørt.">Svar godkendt: ${counts.approved}/${counts.raw}</span>
                <span class="status-pill ${materialsCount.approved === materialsCount.raw && materialsCount.raw > 0 ? 'ready' : 'progress'}">Materiale godkendt: ${materialsCount.approved}/${materialsCount.raw}</span>
                <span class="status-pill ready">Publicerede svar: ${counts.published}/${counts.raw}</span>
                <span class="status-pill ready">Publicerede materialer: ${materialsCount.published}/${materialsCount.raw}</span>
                ${publishedAt ? `<span class="status-pill ready">Publiceret ${formatDateDisplay(publishedAt)}</span>` : ''}
            </div>
            <div style="margin-top:var(--space-sm);display:grid;gap:var(--space-xs);font-size:var(--font-size-sm);color:var(--color-gray-600);">
                <span>Deadline: ${formatDeadline(detail.hearing?.deadline)}</span>
                <span>Status: ${detail.hearing?.status || 'ukendt'}</span>
            </div>
        </div>
    `;
}

function renderRawResponses(detail) {
    // Only show prepared responses - no raw responses display
    const wrapper = document.createElement('div');
    wrapper.className = 'detail-section';
    wrapper.dataset.section = 'prepared-responses-only';
    
    // Get counts from server (paginated mode) or calculate locally
    const preparedResponses = detail.prepared?.responses || [];
    const counts = state.counts || detail.counts || {
        total: preparedResponses.length,
        approved: preparedResponses.filter(r => r.approved).length,
        pending: preparedResponses.filter(r => !r.approved).length,
        raw: detail.raw?.responses?.length || 0
    };
    
    const isPaginated = detail.paginated === true;
    const { page, pageSize, pendingOnly, totalResponses, totalPages, search } = state.pagination;
    
    // Button state for filter toggle
    const isFilterActive = pendingOnly;
    const filterButtonClass = isFilterActive ? 'btn btn-filter active' : 'btn btn-filter';
    const filterButtonText = isFilterActive ? 'Vis alle' : 'Kun afventende';
    
    wrapper.innerHTML = `
        <div class="response-section-header" style="flex-wrap: wrap; gap: var(--space-sm);">
            <div style="display:flex;align-items:center;gap:var(--space-sm);">
                <h2>Høringssvar</h2>
                <span class="status-pill" style="font-size: var(--font-size-xs);">
                    ${counts.approved}/${counts.total} godkendt
                </span>
            </div>
            <div style="display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap;">
                <button id="filter-pending-btn" class="${filterButtonClass}" title="${isFilterActive ? 'Vis alle svar' : 'Vis kun svar der mangler godkendelse'}">
                    <svg class="icon" style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
                    </svg>
                    <span>${filterButtonText}</span>
                    <span class="filter-count">${counts.pending}</span>
                </button>
                <div class="search-box" style="display:flex;align-items:center;gap:var(--space-xs);">
                    <input type="text" id="response-search" placeholder="Søg i svar..." value="${search || ''}" 
                           style="padding:var(--space-xs) var(--space-sm);border:1px solid var(--color-gray-300);border-radius:var(--radius-sm);font-size:var(--font-size-sm);width:150px;">
                    <button id="response-search-btn" class="btn btn-sm" style="padding:var(--space-xs) var(--space-sm);">Søg</button>
                </div>
            </div>
        </div>
        ${isPaginated ? `
        <div class="pagination-controls" style="display:flex;align-items:center;justify-content:space-between;margin:var(--space-sm) 0;padding:var(--space-sm);background:var(--color-gray-100);border-radius:var(--radius-sm);">
            <div style="color:var(--color-gray-600);font-size:var(--font-size-sm);">
                Viser ${preparedResponses.length} af ${totalResponses} svar ${isFilterActive ? '(kun afventende)' : '(alle)'}
            </div>
            <div style="display:flex;align-items:center;gap:var(--space-sm);">
                <button id="page-first" class="btn btn-sm" ${page <= 1 ? 'disabled' : ''} title="Første side">«</button>
                <button id="page-prev" class="btn btn-sm" ${page <= 1 ? 'disabled' : ''} title="Forrige side">‹</button>
                <span style="font-size:var(--font-size-sm);min-width:80px;text-align:center;">
                    Side ${page} af ${totalPages || 1}
                </span>
                <button id="page-next" class="btn btn-sm" ${page >= totalPages ? 'disabled' : ''} title="Næste side">›</button>
                <button id="page-last" class="btn btn-sm" ${page >= totalPages ? 'disabled' : ''} title="Sidste side">»</button>
                <select id="page-size" style="padding:var(--space-xs);border:1px solid var(--color-gray-300);border-radius:var(--radius-sm);font-size:var(--font-size-sm);">
                    <option value="25" ${pageSize === 25 ? 'selected' : ''}>25 pr. side</option>
                    <option value="50" ${pageSize === 50 ? 'selected' : ''}>50 pr. side</option>
                    <option value="100" ${pageSize === 100 ? 'selected' : ''}>100 pr. side</option>
                    <option value="200" ${pageSize === 200 ? 'selected' : ''}>200 pr. side</option>
                </select>
            </div>
        </div>
        ` : `
        <p style="margin-top:var(--space-xs);color:var(--color-gray-600);font-size:var(--font-size-sm);">
            Redigér den klargjorte kopi og gem dine ændringer. Svar markeres automatisk som klargjort når der gemmes.
        </p>
        `}
    `;
    
    const list = document.createElement('div');
    list.className = 'card-list';
    const rawResponses = detail.raw?.responses || [];
    const usedPreparedIds = new Set();

    // Responses are already sorted and filtered by server in paginated mode
    const allPreparedSorted = isPaginated ? preparedResponses : [...preparedResponses].sort((a, b) => {
        const aSourceId = Number(a.sourceResponseId);
        const bSourceId = Number(b.sourceResponseId);
        if (aSourceId && bSourceId) return aSourceId - bSourceId;
        return Number(a.preparedId) - Number(b.preparedId);
    });

    if (!preparedResponses.length && rawResponses.length) {
        list.innerHTML = '<div class="list-empty">Ingen klargjorte svar endnu. Klik på "Fuld nulstil" for at oprette klargjorte svar fra de originale høringssvar.</div>';
    } else if (!preparedResponses.length && !rawResponses.length) {
        list.innerHTML = '<div class="list-empty">Ingen svar hentet fra blivhørt endnu.</div>';
    } else if (!preparedResponses.length && isPaginated && totalResponses > 0) {
        list.innerHTML = '<div class="list-empty">Ingen svar matcher filteret. Prøv at vise alle svar.</div>';
    } else {
        allPreparedSorted.forEach((prepared) => {
            const svarnummer = prepared.sourceResponseId ? Number(prepared.sourceResponseId) : Number(prepared.preparedId);
            const preparedCard = createPreparedResponseCard(prepared, svarnummer);
            list.appendChild(preparedCard);
            usedPreparedIds.add(Number(prepared.preparedId));
        });
    }
    wrapper.appendChild(list);
    wrapper.usedPreparedIds = usedPreparedIds;
    
    // Add event listeners for pagination after element is in DOM
    setTimeout(() => addPaginationListeners(), 0);
    
    return wrapper;
}

function addPaginationListeners() {
    // Filter toggle
    const filterBtn = document.getElementById('filter-pending-btn');
    if (filterBtn) {
        filterBtn.onclick = async () => {
            const newPendingOnly = !state.pagination.pendingOnly;
            state.pagination.pendingOnly = newPendingOnly;
            state.pagination.page = 1; // Reset to first page when toggling filter
            await loadHearingDetail(state.currentId);
        };
    }
    
    // Search
    const searchInput = document.getElementById('response-search');
    const searchBtn = document.getElementById('response-search-btn');
    if (searchInput && searchBtn) {
        const doSearch = async () => {
            state.pagination.search = searchInput.value.trim();
            state.pagination.page = 1;
            await loadHearingDetail(state.currentId);
        };
        searchBtn.onclick = doSearch;
        searchInput.onkeypress = (e) => { if (e.key === 'Enter') doSearch(); };
    }
    
    // Pagination buttons
    const pageFirst = document.getElementById('page-first');
    const pagePrev = document.getElementById('page-prev');
    const pageNext = document.getElementById('page-next');
    const pageLast = document.getElementById('page-last');
    const pageSize = document.getElementById('page-size');
    
    if (pageFirst) pageFirst.onclick = () => goToPage(1);
    if (pagePrev) pagePrev.onclick = () => goToPage(state.pagination.page - 1);
    if (pageNext) pageNext.onclick = () => goToPage(state.pagination.page + 1);
    if (pageLast) pageLast.onclick = () => goToPage(state.pagination.totalPages);
    
    if (pageSize) {
        pageSize.onchange = async (e) => {
            state.pagination.pageSize = parseInt(e.target.value, 10);
            state.pagination.page = 1;
            await loadHearingDetail(state.currentId);
        };
    }
}

async function goToPage(page) {
    if (page < 1 || page > state.pagination.totalPages) return;
    state.pagination.page = page;
    // Scroll to top of responses section
    const section = document.querySelector('[data-section="prepared-responses-only"]');
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    await loadHearingDetail(state.currentId);
}

function createBadge(text) {
    const span = document.createElement('span');
    span.className = 'badge';
    span.textContent = text;
    return span;
}

function calculateBlivhoertPageLink(hearingId, sourceResponseId, sourcePage) {
    if (!sourceResponseId || !hearingId) return null;
    // Use the stored page number if available, otherwise fall back to calculation
    const page = sourcePage !== null && sourcePage !== undefined ? Number(sourcePage) : Math.ceil(Number(sourceResponseId) / 12);
    // Use URL constructor to ensure clean query parameters
    const url = new URL(`https://blivhoert.kk.dk/hearing/${hearingId}/comments`);
    url.searchParams.set('Page', String(page));
    return url.toString();
}

function createPreparedResponseCard(prepared, svarnummer = null) {
    const card = createCardFromTemplate('preparedResponse');
    card.dataset.preparedId = prepared.preparedId;
    // Add is-approved class for filtering
    if (prepared.approved) {
        card.classList.add('is-approved');
    }
    const title = card.querySelector('.title-group');
    // Use provided svarnummer, or fallback to sourceResponseId, or finally preparedId
    const displaySvarnummer = svarnummer || (prepared.sourceResponseId ? Number(prepared.sourceResponseId) : Number(prepared.preparedId));
    const svarnummerText = `Svarnummer ${displaySvarnummer}`;
    title.innerHTML = `<strong>${svarnummerText}</strong>
        <div class="pill-group" style="margin-top:var(--space-xs);">
            <div style="display:flex;gap:var(--space-sm);align-items:center;flex-wrap:wrap;">
                <label style="display:flex;gap:var(--space-xs);align-items:center;font-size:var(--font-size-sm);">
                    <span>Navn:</span>
                    <input type="text" data-role="respondent-name" value="${prepared.respondentName || 'Borger'}" style="padding:var(--space-xs);border:1px solid var(--color-gray-300);border-radius:var(--radius-sm);font-size:var(--font-size-sm);" placeholder="Borger">
                </label>
                <label style="display:flex;gap:var(--space-xs);align-items:center;font-size:var(--font-size-sm);">
                    <span>Type:</span>
                    <select data-role="respondent-type" style="padding:var(--space-xs);border:1px solid var(--color-gray-300);border-radius:var(--radius-sm);font-size:var(--font-size-sm);">
                        <option value="Borger" ${(prepared.respondentType || 'Borger') === 'Borger' ? 'selected' : ''}>Borger</option>
                        <option value="Organisation" ${prepared.respondentType === 'Organisation' ? 'selected' : ''}>Organisation</option>
                        <option value="Myndighed" ${prepared.respondentType === 'Myndighed' ? 'selected' : ''}>Myndighed</option>
                        <option value="Lokaludvalg" ${prepared.respondentType === 'Lokaludvalg' ? 'selected' : ''}>Lokaludvalg</option>
                        <option value="Politisk parti" ${prepared.respondentType === 'Politisk parti' ? 'selected' : ''}>Politisk parti</option>
                    </select>
                </label>
            </div>
            ${prepared.hasAttachments ? '<span class="badge" style="margin-top:var(--space-xs);">Vedhæftninger</span>' : ''}
        </div>`;
    const approvedCheckbox = card.querySelector('[data-role="approved"]');
    approvedCheckbox.checked = !!prepared.approved;
    const textArea = card.querySelector('textarea[data-role="text"]');
    textArea.value = prepared.textMd || prepared.text || '';
    setupTextareaAutoResize(textArea);
    
    // Show focus selector if there are attachments
    const focusSelector = card.querySelector('.response-focus-selector');
    if (focusSelector && prepared.hasAttachments && Array.isArray(prepared.attachments) && prepared.attachments.length > 0) {
        focusSelector.style.display = 'block';
        const focusSelect = focusSelector.querySelector('[data-role="focus-mode"]');
        focusSelect.value = prepared.focusMode || 'response';
        focusSelect.dataset.preparedId = prepared.preparedId;
    } else if (focusSelector) {
        focusSelector.style.display = 'none';
    }
    
    const saveBtn = card.querySelector('[data-action="save"]');
    saveBtn.dataset.preparedId = prepared.preparedId;
    const resetBtn = card.querySelector('[data-action="reset-prepared"]');
    if (resetBtn) {
        resetBtn.dataset.preparedId = prepared.preparedId;
        if (!prepared.sourceResponseId) {
            resetBtn.disabled = true;
            resetBtn.title = 'Ingen tilknyttet original at nulstille til';
        }
    }
    const attachmentsContainer = card.querySelector('.attachments');
    attachmentsContainer.innerHTML = '';
    if (Array.isArray(prepared.attachments) && prepared.attachments.length) {
        prepared.attachments.forEach((att) => {
            const attCard = createCardFromTemplate('attachment');
            attCard.dataset.attachmentId = att.attachmentId;
            attCard.dataset.preparedId = prepared.preparedId;
            attCard.querySelector('.attachment-title').textContent = att.originalFilename || `Bilag ${att.attachmentId}`;
            
            // Add link to blivhørt page if we have source response ID
            const linksContainer = attCard.querySelector('.attachment-links');
            if (linksContainer && prepared.sourceResponseId && state.currentId) {
                const blivhoertLink = calculateBlivhoertPageLink(state.currentId, prepared.sourceResponseId, prepared.sourcePage);
                if (blivhoertLink) {
                    linksContainer.innerHTML = `
                        <a href="${blivhoertLink}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:var(--space-xs);color:var(--color-primary);text-decoration:none;font-size:var(--font-size-sm);">
                            <svg class="icon" style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                                <polyline points="15 3 21 3 21 9"></polyline>
                                <line x1="10" y1="14" x2="21" y2="3"></line>
                            </svg>
                            Åbn på blivhørt
                        </a>
                    `;
                }
            }
            
            // Setup fetch button for single attachment
            const fetchBtn = attCard.querySelector('[data-action="fetch-single-attachment"]');
            if (fetchBtn) {
                fetchBtn.dataset.attachmentId = att.attachmentId;
                fetchBtn.dataset.preparedId = prepared.preparedId;
                fetchBtn.dataset.sourceResponseId = prepared.sourceResponseId;
                if (att.sourceAttachmentIdx !== undefined && att.sourceAttachmentIdx !== null) {
                    fetchBtn.dataset.sourceIdx = att.sourceAttachmentIdx;
                }
                // Hide if already has content
                if (att.convertedMd && att.convertedMd.trim().length > 0) {
                    fetchBtn.style.display = 'none';
                }
            }
            const saveAttachmentBtn = attCard.querySelector('[data-action="save-attachment"]');
            saveAttachmentBtn.dataset.attachmentId = att.attachmentId;
            saveAttachmentBtn.dataset.preparedId = prepared.preparedId;
            const attApproved = attCard.querySelector('[data-role="attachment-approved"]');
            attApproved.checked = !!att.approved;
            attApproved.dataset.attachmentId = att.attachmentId;
            attApproved.dataset.preparedId = prepared.preparedId;
            const attTextarea = attCard.querySelector('[data-role="attachment-text"]');
            attTextarea.value = att.convertedMd || '';
            setupTextareaAutoResize(attTextarea);
            attTextarea.dataset.attachmentId = att.attachmentId;
            attTextarea.dataset.preparedId = prepared.preparedId;
            attachmentsContainer.appendChild(attCard);
        });
    }
    return card;
}

function renderPreparedResponses(detail, skipSet = new Set()) {
    const responses = (detail.prepared?.responses || []).filter((resp) => !skipSet.has(Number(resp.preparedId)));
    if (!responses.length) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'detail-section';
    wrapper.dataset.section = 'prepared-responses';
    wrapper.innerHTML = '<h2>Klargjorte høringssvar uden original</h2>';
    const list = document.createElement('div');
    list.className = 'card-list';

    const allPreparedSorted = [...responses].sort((a, b) => {
        const aId = Number(a.preparedId);
        const bId = Number(b.preparedId);
        return aId - bId;
    });
    const svarnummerMap = new Map();
    allPreparedSorted.forEach((p, idx) => {
        svarnummerMap.set(Number(p.preparedId), idx + 1);
    });

    responses.forEach((resp) => {
        const svarnummer = svarnummerMap.get(Number(resp.preparedId)) || 0;
        const card = createPreparedResponseCard(resp, svarnummer);
        list.appendChild(card);
    });

    wrapper.appendChild(list);
    return wrapper;
}

function renderMaterials(detail) {
    const wrapper = document.createElement('div');
    wrapper.className = 'detail-section';
    wrapper.dataset.section = 'materials';
    wrapper.innerHTML = `
        <h2>Høringsmateriale</h2>
        <div class="material-upload">
            <input type="file" id="material-upload" accept=".pdf,.md,.markdown,.txt">
            <button class="btn btn-secondary" data-action="refresh-materials">Opdater</button>
        </div>
    `;
    const list = document.createElement('div');
    list.className = 'card-list';
    const materials = detail.prepared?.materials || [];
    if (!materials.length) {
        list.innerHTML = '<div class="list-empty">Ingen klargjorte materialer endnu.</div>';
    } else {
        materials.forEach((mat) => {
            const card = createCardFromTemplate('material');
            card.dataset.materialId = mat.materialId;
            card.querySelector('.material-title').textContent = mat.title || `Materiale ${mat.materialId}`;
            const badges = card.querySelector('[data-role="material-badges"]');
            if (mat.sourceFilename) badges.appendChild(createBadge(mat.sourceFilename));
            const approvedCheckbox = card.querySelector('[data-role="material-approved"]');
            approvedCheckbox.checked = !!mat.approved;
            approvedCheckbox.dataset.materialId = mat.materialId;
            const textArea = card.querySelector('[data-role="material-text"]');
            // Only show contentMd if it exists - if not, material is in original format (uploadedPath)
            // and will be converted at prompt time
            // IMPORTANT: Don't show converted content if material has uploadedPath but no contentMd
            // This means it's kept in original format until prompt time
            if (mat.uploadedPath && !mat.contentMd) {
                // Material is in original format - textarea should be empty
                textArea.value = '';
                textArea.placeholder = 'Materialet er i originalt format og vil blive konverteret automatisk ved prompt-tid. Du kan også manuelt konvertere og indsætte indhold her.';
            } else {
                // Show existing contentMd if available
                textArea.value = mat.contentMd || '';
            }
            setupTextareaAutoResize(textArea);
            textArea.dataset.materialId = mat.materialId;
            const saveBtn = card.querySelector('[data-action="save-material"]');
            saveBtn.dataset.materialId = mat.materialId;
            const deleteBtn = card.querySelector('[data-action="delete-material"]');
            deleteBtn.dataset.materialId = mat.materialId;
            list.appendChild(card);
        });
    }
    wrapper.appendChild(list);
    return wrapper;
}

function renderPublishedSection(detail) {
    const wrapper = document.createElement('div');
    wrapper.className = 'detail-section';
    wrapper.dataset.section = 'published';
    const responses = detail.published?.responses || [];
    const materials = detail.published?.materials || [];
    wrapper.innerHTML = `
        <h2>Publiceret</h2>
        <p>Publicerede svar: ${responses.length}. Publicerede materialer: ${materials.length}.</p>
    `;
    return wrapper;
}

function renderFooter(detail) {
    const counts = {
        raw: detail.raw?.responses?.length || 0,
        approved: (detail.prepared?.responses || []).filter(r => r.approved).length
    };
    const materialsCount = {
        raw: detail.raw?.materials?.length || 0,
        approved: (detail.prepared?.materials || []).filter(m => m.approved).length
    };
    
    let footerEl = document.getElementById('publish-footer');
    if (!footerEl) {
        footerEl = document.createElement('div');
        footerEl.id = 'publish-footer';
        footerEl.className = 'publish-footer';
        document.body.appendChild(footerEl);
    }
    
    const readyCount = counts.approved + materialsCount.approved;
    footerEl.innerHTML = `
        <div class="publish-footer-content">
            <div class="publish-footer-info">
                <div class="publish-footer-text">
                    ${readyCount} godkendt${readyCount !== 1 ? 'e' : ''} element${readyCount !== 1 ? 'er' : ''} klar til publicering
                </div>
                <div class="publish-footer-hint">
                    Kun godkendte svar og materiale vil blive publiceret
                </div>
            </div>
            <button id="publish-btn-footer" class="btn btn-primary publish-footer-btn">Publicer alle godkendte</button>
        </div>
    `;
    
    const footerBtn = footerEl.querySelector('#publish-btn-footer');
    if (footerBtn) {
        footerBtn.addEventListener('click', handlePublish);
    }
}

function renderHearingDetail() {
    if (!state.detail) return;
    const detail = state.detail;
    const doc = document.createDocumentFragment();
    const container = document.createElement('div');
    container.innerHTML = renderStateSection(detail);
    doc.appendChild(container.firstElementChild);
    // Only show prepared responses - no raw responses section
    const responsesSection = renderRawResponses(detail);
    doc.appendChild(responsesSection);
    doc.appendChild(renderMaterials(detail));
    detailEl.innerHTML = '';
    detailEl.appendChild(doc);
    
    // Add event listeners for publish button
    const publishBtnTop = detailEl.querySelector('#publish-btn-top');
    if (publishBtnTop) {
        publishBtnTop.addEventListener('click', handlePublish);
    }
    
    // Actions menu toggle
    const actionsBtn = detailEl.querySelector('#hearing-actions-btn');
    const actionsMenu = detailEl.querySelector('#hearing-actions-menu');
    if (actionsBtn && actionsMenu) {
        actionsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = actionsMenu.style.display !== 'none';
            actionsMenu.style.display = isVisible ? 'none' : 'block';
        });
        
        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
            if (!actionsMenu.contains(e.target) && e.target !== actionsBtn) {
                actionsMenu.style.display = 'none';
            }
        });
        
        // Handle menu item clicks
        actionsMenu.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', async () => {
                actionsMenu.style.display = 'none';
                const action = item.dataset.action;
                if (action === 'refresh-raw') {
                    await handleRefreshRaw();
                } else if (action === 'fetch-attachments') {
                    await handleFetchAttachments();
                } else if (action === 'reset-hearing') {
                    await handleResetHearing();
                } else if (action === 'delete-hearing') {
                    await handleDeleteHearing();
                }
            });
        });
    }
    
    // Render footer separately (appended to body)
    renderFooter(detail);
}

async function handleUploadAttachment(preparedId, attachmentId, file) {
    if (!file || !state.currentId) return;
    
    try {
        const formData = new FormData();
        formData.append('file', file);
        
        showInfo('Uploader vedhæftning...');
        
        const uploadRes = await fetch(`/api/gdpr/hearing/${state.currentId}/responses/${preparedId}/attachments/${attachmentId}/upload`, {
            method: 'POST',
            body: formData
        });
        
        const uploadData = await uploadRes.json();
        if (!uploadRes.ok || uploadData.success === false) {
            throw new Error(uploadData.error || uploadData.message || 'Upload mislykkedes');
        }
        
        // After upload, convert to markdown automatically
        showInfo('Konverterer til markdown...');
        
        const convertRes = await fetch(`/api/gdpr/hearing/${state.currentId}/responses/${preparedId}/attachments/${attachmentId}/convert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uploadedPath: uploadData.storedPath,
                originalFilename: uploadData.originalName
            })
        });
        
        const convertData = await convertRes.json();
        if (!convertRes.ok || convertData.success === false) {
            const errorMsg = convertData.detail || convertData.error || convertData.message || 'Konvertering mislykkedes';
            console.error('[Upload] Conversion error:', convertData);
            throw new Error(errorMsg);
        }
        
        // Save scroll position before reload
        const scrollPos = detailEl.scrollTop;
        
        await loadHearingDetail(state.currentId);
        
        // Restore scroll position
        setTimeout(() => {
            if (detailEl) {
                detailEl.scrollTop = scrollPos;
            }
        }, 10);
        
        showSuccess('Vedhæftning uploadet og konverteret.');
    } catch (error) {
        const errorMsg = error.message || 'Upload mislykkedes';
        console.error('[Upload] Full error:', error);
        // Show the error message, and if it contains newlines, show first line and log full message
        const lines = errorMsg.split('\n');
        const firstLine = lines[0];
        if (lines.length > 1) {
            console.error('[Upload] Full error details:', errorMsg);
            showError(`Upload mislykkedes: ${firstLine} (se konsollen for detaljer)`);
        } else {
            showError(`Upload mislykkedes: ${errorMsg}`);
        }
    }
}

async function handleSavePrepared(preparedId) {
    if (!state.detail || !state.currentId) return;
    const card = detailEl.querySelector(`.prepared-response[data-prepared-id="${preparedId}"]`);
    if (!card) return;
    const textArea = card.querySelector('textarea[data-role="text"]');
    const approvedCheckbox = card.querySelector('[data-role="approved"]');
    const respondentNameInput = card.querySelector('[data-role="respondent-name"]');
    const respondentTypeSelect = card.querySelector('[data-role="respondent-type"]');
    const focusSelect = card.querySelector('[data-role="focus-mode"]');
    const prepared = (state.detail.prepared?.responses || []).find(r => Number(r.preparedId) === Number(preparedId));
    if (!prepared) return;
    
    // Collect new values
    const now = Date.now();
    const newData = {
        preparedId,
        sourceResponseId: prepared.sourceResponseId ?? null,
        respondentName: respondentNameInput ? respondentNameInput.value : (prepared.respondentName ?? 'Borger'),
        respondentType: respondentTypeSelect ? respondentTypeSelect.value : (prepared.respondentType ?? 'Borger'),
        author: prepared.author ?? null,
        organization: prepared.organization ?? null,
        onBehalfOf: prepared.onBehalfOf ?? null,
        submittedAt: prepared.submittedAt ?? null,
        textMd: textArea.value,
        hasAttachments: prepared.hasAttachments,
        attachmentsReady: prepared.attachmentsReady,
        focusMode: focusSelect ? focusSelect.value : (prepared.focusMode || 'response'),
        approved: true,
        approvedAt: now,
        notes: prepared.notes ?? null
    };
    
    try {
        // Optimistic UI update - update card immediately
        approvedCheckbox.checked = true;
        card.classList.add('is-approved');
        
        // Save to server
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/responses`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newData)
        });
        
        // Update local state without reloading everything
        Object.assign(prepared, {
            respondentName: newData.respondentName,
            respondentType: newData.respondentType,
            textMd: newData.textMd,
            focusMode: newData.focusMode,
            approved: true,
            approvedAt: now,
            updatedAt: now
        });
        
        // Update counts in state
        if (state.counts) {
            state.counts.approved = (state.counts.approved || 0) + 1;
            state.counts.pending = Math.max(0, (state.counts.pending || 0) - 1);
        }
        
        // Update header counts display
        updateHeaderCounts();
        
        // Show inline "Gemt ✓" feedback in the card
        const inlineFeedback = document.createElement('div');
        inlineFeedback.className = 'inline-save-feedback';
        inlineFeedback.textContent = '✓ Gemt';
        inlineFeedback.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: var(--color-success, #22c55e);
            color: white;
            padding: var(--space-sm) var(--space-md);
            border-radius: var(--radius-md);
            font-weight: 600;
            font-size: var(--font-size-lg);
            z-index: 10;
            animation: fadeInScale 0.2s ease-out;
        `;
        card.style.position = 'relative';
        card.appendChild(inlineFeedback);
        
        // If pendingOnly filter is active and this item is now approved, 
        // animate it out and remove from DOM
        if (state.pagination.pendingOnly) {
            setTimeout(() => {
                card.style.transition = 'opacity 0.3s, transform 0.3s, max-height 0.3s';
                card.style.opacity = '0';
                card.style.transform = 'translateX(20px)';
                card.style.maxHeight = card.offsetHeight + 'px';
                card.style.overflow = 'hidden';
            }, 300);
            
            setTimeout(() => {
                card.style.maxHeight = '0';
                card.style.marginBottom = '0';
                card.style.paddingTop = '0';
                card.style.paddingBottom = '0';
            }, 450);
            
            setTimeout(() => {
                card.remove();
                // Update displayed count
                const remaining = detailEl.querySelectorAll('.prepared-response').length;
                const paginationInfo = document.querySelector('.pagination-controls > div:first-child');
                if (paginationInfo) {
                    paginationInfo.textContent = `Viser ${remaining} af ${state.pagination.totalResponses} svar (kun afventende)`;
                }
                
                // If no cards left on this page, auto-load next page (or first page if more exist)
                if (remaining === 0 && state.pagination.totalResponses > 0) {
                    const nextPage = state.pagination.page < state.pagination.totalPages 
                        ? state.pagination.page + 1 
                        : 1;
                    loadHearingDetail(state.currentId, nextPage, state.pagination.pageSize, true, state.searchTerm);
                }
            }, 700);
        } else {
            // If not in pendingOnly mode, just fade out the feedback after a moment
            setTimeout(() => {
                inlineFeedback.style.transition = 'opacity 0.3s';
                inlineFeedback.style.opacity = '0';
                setTimeout(() => inlineFeedback.remove(), 300);
            }, 800);
        }
        
        // No popup notification - feedback is inline
    } catch (error) {
        // Revert optimistic update on error
        approvedCheckbox.checked = prepared.approved;
        if (!prepared.approved) card.classList.remove('is-approved');
        showError(`Fejl ved gem af svar: ${error.message}`);
    }
}

// Helper to update header counts without full reload
function updateHeaderCounts() {
    const counts = state.counts;
    if (!counts) return;
    
    // Update the status pill in the header
    const statusPills = document.querySelectorAll('.status-pill');
    statusPills.forEach(pill => {
        if (pill.textContent.includes('godkendt')) {
            pill.textContent = `${counts.approved}/${counts.total} godkendt`;
        }
    });
    
    // Update filter button count
    const filterCount = document.querySelector('.filter-count');
    if (filterCount) {
        filterCount.textContent = counts.pending;
    }
    
    // Update pagination info
    const paginationInfo = document.querySelector('.pagination-controls > div:first-child');
    if (paginationInfo && state.pagination.pendingOnly) {
        // Decrement the shown count if we're in pending-only mode
        const currentText = paginationInfo.textContent;
        const match = currentText.match(/Viser (\d+) af (\d+)/);
        if (match) {
            const shown = parseInt(match[1], 10);
            const total = Math.max(0, parseInt(match[2], 10) - 1);
            paginationInfo.textContent = `Viser ${shown} af ${total} svar (kun afventende)`;
            state.pagination.totalResponses = total;
        }
    }
}

async function handleSaveAttachment(preparedId, attachmentId) {
    const container = detailEl.querySelector(`.attachment-block[data-attachment-id="${attachmentId}"][data-prepared-id="${preparedId}"]`) || detailEl.querySelector(`.attachment-block[data-prepared-id="${preparedId}"]`);
    const parentCard = detailEl.querySelector(`.prepared-response[data-prepared-id="${preparedId}"]`);
    if (!container || !parentCard) return;
    const textArea = container.querySelector('[data-role="attachment-text"]');
    const approvedCheckbox = container.querySelector('[data-role="attachment-approved"]');
    
    const now = Date.now();
    
    try {
        // Optimistic UI update
        approvedCheckbox.checked = true;
        
        // Save to server
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/responses/${preparedId}/attachments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                attachmentId,
                convertedMd: textArea.value,
                approved: true,
                approvedAt: now,
                conversionStatus: 'manual-edit'
            })
        });
        
        // Update local state without reloading
        const prepared = (state.detail?.prepared?.responses || []).find(r => Number(r.preparedId) === Number(preparedId));
        if (prepared) {
            const attachment = (prepared.attachments || []).find(a => Number(a.attachmentId) === Number(attachmentId));
            if (attachment) {
                attachment.convertedMd = textArea.value;
                attachment.approved = true;
                attachment.approvedAt = now;
                attachment.conversionStatus = 'manual-edit';
            }
        }
        
        showSuccess('Vedhæftning gemt og godkendt.');
    } catch (error) {
        // Revert on error
        approvedCheckbox.checked = false;
        showError(`Fejl ved gem af vedhæftning: ${error.message}`);
    }
}

async function handleConvertAttachment(preparedId, attachmentId, sourceIdx) {
    // Save current scroll position
    const scrollPos = detailEl.scrollTop;
    
    try {
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/responses/${preparedId}/attachments/${attachmentId}/convert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rawAttachmentIdx: sourceIdx })
        });
        await loadHearingDetail(state.currentId);
        
        // Restore scroll position after a brief delay to allow render
        setTimeout(() => {
            if (detailEl) {
                detailEl.scrollTop = scrollPos;
            }
        }, 10);
        
        showSuccess('Vedhæftning konverteret.');
    } catch (error) {
        showError(`Konvertering mislykkedes: ${error.message}`);
    }
}

async function handleFetchSingleAttachment(preparedId, attachmentId, sourceIdx, sourceResponseId, button) {
    // Fetch and convert a single attachment from blivhørt
    try {
        // Show loading state on button
        const originalText = button.textContent;
        button.textContent = 'Henter...';
        button.disabled = true;
        
        const result = await fetchJson(`/api/gdpr/hearing/${state.currentId}/fetch-single-attachment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                preparedId, 
                attachmentId, 
                sourceIdx,
                sourceResponseId 
            })
        });
        
        if (result.success && result.markdown) {
            // Update the textarea directly without full reload
            const card = button.closest('.prepared-response');
            const attBlock = button.closest('.attachment-block');
            if (attBlock) {
                const textarea = attBlock.querySelector('[data-role="attachment-text"]');
                if (textarea) {
                    textarea.value = result.markdown;
                    // Trigger resize
                    autoResizeTextarea(textarea);
                }
            }
            // Hide the fetch button since we now have content
            button.style.display = 'none';
            showSuccess('Vedhæftning hentet og konverteret.');
        } else {
            throw new Error(result.error || 'Kunne ikke hente vedhæftning');
        }
    } catch (error) {
        showError(`Hentning mislykkedes: ${error.message}`);
        // Restore button
        button.textContent = 'Hent fil';
        button.disabled = false;
    }
}

async function handleSaveMaterial(materialId) {
    const card = detailEl.querySelector(`.material-item[data-material-id="${materialId}"]`);
    if (!card) return;
    const textArea = card.querySelector('[data-role="material-text"]');
    const approvedCheckbox = card.querySelector('[data-role="material-approved"]');
    const material = (state.detail.prepared?.materials || []).find(m => Number(m.materialId) === Number(materialId));
    if (!material) return;
    
    const now = Date.now();
    
    try {
        // Optimistic UI update
        approvedCheckbox.checked = true;
        
        // Save to server
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/materials`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                materialId,
                title: material.title,
                sourceFilename: material.sourceFilename,
                sourceUrl: material.sourceUrl,
                uploadedPath: material.uploadedPath,
                contentMd: textArea.value,
                approved: true,
                approvedAt: now
            })
        });
        
        // Update local state without reloading
        material.contentMd = textArea.value;
        material.approved = true;
        material.approvedAt = now;
        material.updatedAt = now;
        
        showSuccess('Materiale gemt og godkendt.');
    } catch (error) {
        // Revert on error
        approvedCheckbox.checked = material.approved || false;
        showError(`Fejl ved gem af materiale: ${error.message}`);
    }
}

async function handleDeleteMaterial(materialId) {
    if (!confirm('Slet dette materiale?')) return;
    
    // Save current scroll position
    const scrollPos = detailEl.scrollTop;
    
    try {
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/materials/${materialId}`, { method: 'DELETE' });
        await loadHearingDetail(state.currentId);
        
        // Restore scroll position after a brief delay to allow render
        setTimeout(() => {
            if (detailEl) {
                detailEl.scrollTop = scrollPos;
            }
        }, 10);
        
        showSuccess('Materiale slettet.');
    } catch (error) {
        showError(`Kunne ikke slette materiale: ${error.message}`);
    }
}

async function handleUploadMaterial(file) {
    if (!file) return;
    try {
        const formData = new FormData();
        formData.append('file', file);
        const uploadRes = await fetch(`/api/gdpr/hearing/${state.currentId}/materials/upload`, {
            method: 'POST',
            body: formData
        });
        const uploadData = await uploadRes.json();
        if (!uploadRes.ok || uploadData.success === false) {
            throw new Error(uploadData.error || uploadData.message || 'Upload mislykkedes');
        }
        // Save scroll position before reload
        const scrollPos = detailEl.scrollTop;
        
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/materials`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: uploadData.originalName,
                sourceFilename: uploadData.originalName,
                uploadedPath: uploadData.storedPath,
                // Don't send contentMd if it's empty - material stays in original format until prompt time
                contentMd: uploadData.contentMd || null,
                approved: false
            })
        });
        await loadHearingDetail(state.currentId);
        
        // Restore scroll position
        setTimeout(() => {
            if (detailEl) {
                detailEl.scrollTop = scrollPos;
            }
        }, 10);
        
        showSuccess('Fil uploadet.');
    } catch (error) {
        showError(`Filupload mislykkedes: ${error.message}`);
    }
}

async function handlePublish() {
    if (!state.currentId) return;
    const confirmPublish = confirm('Vil du publicere alle godkendte svar og materiale? Kun godkendte elementer vil blive publiceret.');
    if (!confirmPublish) return;
    
    // Save current scroll position
    const scrollPos = detailEl.scrollTop;
    
    try {
        // Always publish only approved (onlyApproved defaults to true)
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ onlyApproved: true })
        });
        await Promise.all([addOrUpdateHearingInList(state.currentId), loadHearingDetail(state.currentId)]);
        
        // Restore scroll position after a brief delay to allow render
        setTimeout(() => {
            if (detailEl) {
                detailEl.scrollTop = scrollPos;
            }
        }, 10);
        
        showSuccess('Høringen er publiceret til hovedsiden. Kun godkendte svar og materiale er blevet publiceret.');
    } catch (error) {
        showError(`Kunne ikke publicere: ${error.message}`);
    }
}

async function handleRebuildVector() {
    if (!state.currentId) return;
    
    // Save current scroll position
    const scrollPos = detailEl.scrollTop;
    
    try {
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/vector-store/rebuild`, { method: 'POST' });
        await loadHearingDetail(state.currentId);
        
        // Restore scroll position after a brief delay to allow render
        setTimeout(() => {
            if (detailEl) {
                detailEl.scrollTop = scrollPos;
            }
        }, 10);
        
        showSuccess('Kontekst er genopbygget.');
    } catch (error) {
        showError(`Kunne ikke genopbygge kontekst: ${error.message}`);
    }
}

async function handleResetPrepared(preparedId) {
    if (!state.currentId || !preparedId) return;
    const confirmReset = confirm('Nulstil dette høringssvar til den originale tekst fra blivhørt?');
    if (!confirmReset) return;
    
    // Save current scroll position
    const scrollPos = detailEl.scrollTop;
    
    try {
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/responses/${preparedId}/reset`, { method: 'POST' });
        await loadHearingDetail(state.currentId);
        
        // Restore scroll position after a brief delay to allow render
        setTimeout(() => {
            if (detailEl) {
                detailEl.scrollTop = scrollPos;
            }
        }, 10);
        
        showSuccess('Svar nulstillet til original.');
    } catch (error) {
        showError(`Kunne ikke nulstille svaret: ${error.message}`);
    }
}

async function handleResetHearing() {
    if (!state.currentId) return;
    const confirmReset = confirm('Dette nulstiller alle klargjorte svar og materiale og henter de originale høringssvar og materiale igen fra blivhørt. Vil du fortsætte?');
    if (!confirmReset) return;
    
    // Show loading indicator
    showLoadingIndicator({
        steps: ['Nulstiller høring...', 'Henter høringsdata...', 'Henter svar...', 'Indlæser...'],
        current: 0,
        total: 4
    });
    
    // Mark hearing as loading
    const hearingIndex = state.hearings.findIndex(h => Number(h.hearingId) === Number(state.currentId));
    if (hearingIndex >= 0) {
        state.hearings[hearingIndex].isLoading = true;
        renderHearingList();
    }
    
    try {
        showLoadingIndicator({
            steps: ['Nulstiller høring...', 'Henter høringsdata...', 'Henter svar...', 'Indlæser...'],
            current: 1,
            total: 4
        });
        
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/reset`, { method: 'POST' });
        
        showLoadingIndicator({
            steps: ['Nulstiller høring...', 'Henter høringsdata...', 'Henter svar...', 'Indlæser...'],
            current: 2,
            total: 4,
            progressText: ''
        });
        
        // Start progress tracking for responses
        startRefreshProgressTracking(state.currentId);
        
        const refreshStartTime = Date.now();
        
        // Give it a moment for data to be saved
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const elapsed = Date.now() - refreshStartTime;
        if (elapsed < 2000) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        stopRefreshProgressTracking();
        
        showLoadingIndicator({
            steps: ['Nulstiller høring...', 'Henter høringsdata...', 'Henter svar...', 'Indlæser...'],
            current: 3,
            total: 4
        });
        
        await Promise.all([addOrUpdateHearingInList(state.currentId), loadHearingDetail(state.currentId)]);
        
        // Remove loading state
        if (hearingIndex >= 0) {
            state.hearings[hearingIndex].isLoading = false;
            renderHearingList();
        }
        
        showSuccess('Høringen er nulstillet. De originale høringssvar og materiale er hentet igen fra blivhørt.');
    } catch (error) {
        stopRefreshProgressTracking();
        
        // Remove loading state
        if (hearingIndex >= 0) {
            state.hearings[hearingIndex].isLoading = false;
            renderHearingList();
        }
        
        showError(`Kunne ikke nulstille høringen: ${error.message}`);
    } finally {
        hideLoadingIndicator();
    }
}

async function handleRefreshRaw() {
    if (!state.currentId) return;
    
    // Show loading indicator
    showLoadingIndicator({
        steps: ['Henter høringsdata...', 'Henter svar...', 'Indlæser...'],
        current: 0,
        total: 3
    });
    
    // Mark hearing as loading
    const hearingIndex = state.hearings.findIndex(h => Number(h.hearingId) === Number(state.currentId));
    if (hearingIndex >= 0) {
        state.hearings[hearingIndex].isLoading = true;
        renderHearingList();
    }
    
    try {
        showLoadingIndicator({
            steps: ['Henter høringsdata...', 'Henter svar...', 'Indlæser...'],
            current: 1,
            total: 3,
            progressText: ''
        });
        
        // Start progress tracking
        startRefreshProgressTracking(state.currentId);
        
        const refreshStartTime = Date.now();
        
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/refresh-raw`, { method: 'POST' });
        
        // Keep tracking for a bit after refresh-raw completes, as server may still be saving
        const elapsed = Date.now() - refreshStartTime;
        if (elapsed < 2000) {
            // If it completed very quickly, wait a bit more for data to be saved
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        stopRefreshProgressTracking();
        
        showLoadingIndicator({
            steps: ['Henter høringsdata...', 'Henter svar...', 'Indlæser...'],
            current: 2,
            total: 3
        });
        
        await Promise.all([addOrUpdateHearingInList(state.currentId), loadHearingDetail(state.currentId)]);
        
        // Remove loading state
        if (hearingIndex >= 0) {
            state.hearings[hearingIndex].isLoading = false;
            renderHearingList();
        }
        
        showSuccess('Høringssvar er opdateret fra blivhørt. Godkendte svar er bevaret.');
    } catch (error) {
        stopRefreshProgressTracking();
        
        // Remove loading state
        if (hearingIndex >= 0) {
            state.hearings[hearingIndex].isLoading = false;
            renderHearingList();
        }
        
        showError(`Kunne ikke opdatere høringssvar: ${error.message}`);
    } finally {
        hideLoadingIndicator();
    }
}

async function handleFetchAttachments() {
    if (!state.currentId) return;
    
    showLoadingIndicator({
        steps: ['Henter PDF-vedhæftninger...', 'Konverterer til tekst...'],
        current: 0,
        total: 2
    });
    
    try {
        const result = await fetchJson(`/api/gdpr/hearing/${state.currentId}/fetch-attachments`, { method: 'POST' });
        
        showLoadingIndicator({
            steps: ['Henter PDF-vedhæftninger...', 'Konverterer til tekst...'],
            current: 2,
            total: 2
        });
        
        // Reload hearing detail to show updated attachments
        await loadHearingDetail(state.currentId);
        
        if (result.converted > 0) {
            showSuccess(`Hentede og konverterede ${result.converted} vedhæftninger${result.failed > 0 ? ` (${result.failed} fejlede)` : ''}`);
        } else if (result.total === 0) {
            showSuccess('Ingen vedhæftninger at hente - alle er allerede konverteret eller godkendt');
        } else {
            showError(`Kunne ikke konvertere vedhæftninger (${result.failed} fejlede)`);
        }
    } catch (error) {
        showError(`Kunne ikke hente vedhæftninger: ${error.message}`);
    } finally {
        hideLoadingIndicator();
    }
}

async function handleDeleteHearing() {
    if (!state.currentId) return;
    const confirmDelete = confirm('Dette sletter alle data for denne høring (rå svar, klargjorte svar og materiale). Vil du fortsætte?');
    if (!confirmDelete) return;
    try {
        await fetchJson(`/api/gdpr/hearing/${state.currentId}`, { method: 'DELETE' });
        const deletedId = state.currentId;
        state.currentId = null;
        state.detail = null;
        // Remove from list and server
        state.hearings = state.hearings.filter(h => Number(h.hearingId) !== Number(deletedId));
        await removeHearingFromServer(deletedId);
        renderHearingList();
        detailEl.innerHTML = '';
        const footerEl = document.getElementById('publish-footer');
        if (footerEl) footerEl.remove();
        showSuccess('Høringen er slettet.');
    } catch (error) {
        showError(`Kunne ikke slette høringen: ${error.message}`);
    }
}

hearingListEl.addEventListener('click', (event) => {
    const item = event.target.closest('.hearing-item');
    if (!item) return;
    const id = Number(item.dataset.hearingId);
    if (id) selectHearing(id);
});

detailEl.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    
    // Handle filter pending button
    if (button.id === 'filter-pending-btn') {
        // Toggle the state
        state.filterPendingActive = !state.filterPendingActive;
        
        button.classList.toggle('active', state.filterPendingActive);
        const cardList = detailEl.querySelector('.card-list');
        if (cardList) {
            cardList.classList.toggle('filter-pending', state.filterPendingActive);
        }
        // Update button text
        const textSpan = button.querySelector('span:not(.filter-count)');
        if (textSpan) {
            textSpan.textContent = state.filterPendingActive 
                ? 'Vis alle svar' 
                : 'Vis manglende godkendelse';
        }
        return;
    }
    
    const action = button.dataset.action;
    if (action === 'save') {
        const preparedId = Number(button.dataset.preparedId);
        if (preparedId) await handleSavePrepared(preparedId);
    }
    if (action === 'reset-prepared') {
        const preparedId = Number(button.dataset.preparedId);
        if (preparedId) await handleResetPrepared(preparedId);
    }
    if (action === 'save-attachment') {
        const preparedId = Number(button.dataset.preparedId);
        const attachmentId = Number(button.dataset.attachmentId);
        if (preparedId && attachmentId) await handleSaveAttachment(preparedId, attachmentId);
    }
    if (action === 'convert' || action === 'fetch-single-attachment') {
        const preparedId = Number(button.dataset.preparedId);
        const attachmentId = Number(button.dataset.attachmentId);
        const sourceIdx = button.dataset.sourceIdx !== undefined ? Number(button.dataset.sourceIdx) : null;
        const sourceResponseId = button.dataset.sourceResponseId ? Number(button.dataset.sourceResponseId) : null;
        if (preparedId && attachmentId) await handleFetchSingleAttachment(preparedId, attachmentId, sourceIdx, sourceResponseId, button);
    }
    if (action === 'save-material') {
        const materialId = Number(button.dataset.materialId);
        if (materialId) await handleSaveMaterial(materialId);
    }
    if (action === 'delete-material') {
        const materialId = Number(button.dataset.materialId);
        if (materialId) await handleDeleteMaterial(materialId);
    }
    if (action === 'rebuild-vector') {
        await handleRebuildVector();
    }
    if (action === 'reset-hearing') {
        await handleResetHearing();
    }
    if (button.id === 'publish-btn') {
        await handlePublish();
    }
    if (action === 'refresh-materials') {
        await loadHearingDetail(state.currentId);
    }
});

detailEl.addEventListener('change', async (event) => {
    const input = event.target;
    if (input.id === 'material-upload' && input.files?.length) {
        const file = input.files[0];
        await handleUploadMaterial(file);
        input.value = '';
    }
    // Handle attachment upload
    if (input.dataset.action === 'upload-attachment' && input.files?.length) {
        const file = input.files[0];
        const preparedId = Number(input.dataset.preparedId);
        const attachmentId = Number(input.dataset.attachmentId);
        if (preparedId && attachmentId) {
            await handleUploadAttachment(preparedId, attachmentId, file);
            input.value = '';
        }
    }
    // Handle focus mode change
    if (input.dataset.role === 'focus-mode') {
        const preparedId = Number(input.dataset.preparedId);
        if (preparedId) {
            // Save focus mode immediately
            const prepared = (state.detail?.prepared?.responses || []).find(r => Number(r.preparedId) === Number(preparedId));
            if (prepared) {
                try {
                    await fetchJson(`/api/gdpr/hearing/${state.currentId}/responses`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            preparedId,
                            sourceResponseId: prepared.sourceResponseId ?? null,
                            respondentName: prepared.respondentName ?? 'Borger',
                            respondentType: prepared.respondentType ?? 'Borger',
                            author: prepared.author ?? null,
                            organization: prepared.organization ?? null,
                            onBehalfOf: prepared.onBehalfOf ?? null,
                            submittedAt: prepared.submittedAt ?? null,
                            textMd: prepared.textMd || prepared.text || '',
                            hasAttachments: prepared.hasAttachments,
                            attachmentsReady: prepared.attachmentsReady,
                            focusMode: input.value,
                            approved: prepared.approved || false,
                            approvedAt: prepared.approvedAt || null,
                            notes: prepared.notes ?? null
                        })
                    });
                    // Update local state to match saved value
                    prepared.focusMode = input.value;
                } catch (error) {
                    console.error('Failed to save focus mode:', error);
                }
            }
        }
    }
});

async function init() {
    // Ensure detail section is empty and has no classes
    if (detailEl) {
        detailEl.innerHTML = '';
        detailEl.className = '';
    }
    
    // Clear any existing footer
    const footerEl = document.getElementById('publish-footer');
    if (footerEl) footerEl.remove();
    
    // Reset search state and input
    state.searchTerm = '';
    if (searchInput) {
        searchInput.value = '';
    }
    
    // Reset current hearing state on init - don't auto-select
    // IMPORTANT: Never auto-select a hearing on page load
    state.currentId = null;
    state.detail = null;
    
    // Remove any active classes from hearing items (in case HTML has them)
    const activeItems = document.querySelectorAll('.hearing-item.active');
    activeItems.forEach(item => item.classList.remove('active'));
    
    // Load saved hearings from server (global)
    await loadSavedHearings();
    
    // Don't auto-load hearings - user must use settings modal to search and fetch
    // But render the list to show header count
    renderHearingList();
    
    // Check for URL parameter to auto-load hearing
    const urlParams = new URLSearchParams(window.location.search);
    const hearingIdParam = urlParams.get('id');
    
    if (hearingIdParam) {
        const hearingId = parseInt(hearingIdParam, 10);
        if (hearingId && !isNaN(hearingId)) {
            // Auto-load hearing from URL parameter
            setupSettingsModal();
            setupEventListeners();
            await selectHearing(hearingId);
            return;
        }
    }
    
    // Show initial message if no hearing selected
    detailEl.innerHTML = `
        <div class="detail-section">
            <h2>Vælg en høring</h2>
            <p>Vælg en høring i venstre side for at klargøre høringssvar og materiale.</p>
        </div>
    `;
    
    setupSettingsModal();
    setupEventListeners();
}

function setupSettingsModal() {
    const settingsBtn = document.getElementById('settings-btn');
    const settingsModalBackdrop = document.getElementById('settings-modal-backdrop');
    const settingsModalClose = document.getElementById('settings-modal-close');
    const hearingSearchInput = document.getElementById('hearing-search-input');
    
    if (!settingsBtn || !settingsModalBackdrop) {
        console.warn('Settings modal elements not found');
        return;
    }
    
    function openSettingsModal() {
        settingsModalBackdrop.classList.add('show');
        if (hearingSearchInput) {
            setTimeout(() => hearingSearchInput.focus(), 100);
        }
    }
    
    function closeSettingsModal() {
        settingsModalBackdrop.classList.remove('show');
        if (hearingSearchInput) {
            hearingSearchInput.value = '';
            hideSuggestions();
        }
    }
    
    settingsBtn.addEventListener('click', openSettingsModal);
    if (settingsModalClose) {
        settingsModalClose.addEventListener('click', closeSettingsModal);
    }
    settingsModalBackdrop.addEventListener('click', (e) => {
        if (e.target === settingsModalBackdrop) {
            closeSettingsModal();
        }
    });
    
    // Setup search functionality
    if (hearingSearchInput) {
        setupHearingSearch(hearingSearchInput);
    }
}

let searchTimeout;
let cachedSearchIndex = null;
let lastIndexFetch = 0;
const INDEX_CACHE_TIME = 0;
let currentSearchToken = 0;
let lastSuggestionsKey = '';

async function loadSearchIndex() {
    const noStoreOpts = { cache: 'no-store', headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } };
    try {
        const response = await fetch('/api/hearing-index?db=1', noStoreOpts);
        const data = await response.json().catch(() => ({}));
        if (data && data.success && Array.isArray(data.hearings)) {
            cachedSearchIndex = data.hearings;
            lastIndexFetch = Date.now();
            return data.hearings;
        }
    } catch (error) {
        console.error('Failed to load search index:', error);
    }
    cachedSearchIndex = [];
    lastIndexFetch = Date.now();
    return [];
}

async function searchLocally(query) {
    if (!cachedSearchIndex || INDEX_CACHE_TIME === 0 || Date.now() - lastIndexFetch > INDEX_CACHE_TIME) {
        await loadSearchIndex();
    }
    
    const q = query.toLowerCase();
    const isNumeric = /^\d+$/.test(query);
    const results = [];
    const seenIds = new Set();
    
    // Search in cached index
    if (cachedSearchIndex && cachedSearchIndex.length > 0) {
        const indexResults = cachedSearchIndex.filter(h => {
            if (isNumeric) {
                return String(h.id).includes(query);
            }
            const title = (h.title || '').toLowerCase();
            return title.includes(q) || String(h.id).includes(query);
        });
        indexResults.forEach(r => {
            if (!seenIds.has(String(r.id))) {
                results.push(r);
                seenIds.add(String(r.id));
            }
        });
    }
    
    // Also search in already loaded hearings
    if (state.hearings && state.hearings.length > 0) {
        const loadedResults = state.hearings.filter(h => {
            const hearingId = h.hearingId || h.id;
            if (isNumeric) {
                return String(hearingId).includes(query);
            }
            const title = (h.title || '').toLowerCase();
            return title.includes(q) || String(hearingId).includes(query);
        }).map(h => ({
            id: h.hearingId || h.id,
            title: h.title || `Høring ${h.hearingId || h.id}`,
            deadline: h.deadline || null
        }));
        
        loadedResults.forEach(r => {
            if (!seenIds.has(String(r.id))) {
                results.push(r);
                seenIds.add(String(r.id));
            }
        });
    }
    
    // Also search in database via API if numeric query
    if (isNumeric && query.length >= 1) {
        try {
            const dbResults = await fetchJson(`/api/hearing-index?db=1&q=${encodeURIComponent(query)}`).catch(() => null);
            if (dbResults && Array.isArray(dbResults.hearings)) {
                dbResults.hearings.forEach(h => {
                    if (!seenIds.has(String(h.id))) {
                        results.push({
                            id: h.id,
                            title: h.title || `Høring ${h.id}`,
                            deadline: h.deadline || null
                        });
                        seenIds.add(String(h.id));
                    }
                });
            }
        } catch (e) {
            // Ignore errors
        }
    }
    
    return results.slice(0, 20);
}

function sortSuggestionsForQuery(suggestions, query) {
    const isNumeric = /^\d+$/.test(query);
    if (!isNumeric) return suggestions;
    const exact = [], starts = [], contains = [], others = [];
    for (const item of suggestions) {
        const idStr = String(item.id || '');
        if (idStr === query) exact.push(item);
        else if (idStr.startsWith(query)) starts.push(item);
        else if (idStr.includes(query)) contains.push(item);
        else others.push(item);
    }
    return [].concat(exact, starts, contains, others);
}

function displaySuggestions(suggestions) {
    const suggestionsDiv = document.getElementById('hearing-search-suggestions');
    if (!suggestionsDiv) return;
    
    if (suggestions.length === 0) {
        hideSuggestions();
        return;
    }
    
    const inputEl = document.getElementById('hearing-search-input');
    const currentQuery = inputEl ? inputEl.value.trim() : '';
    const sorted = sortSuggestionsForQuery(suggestions, currentQuery);
    
    const newKey = sorted.map(h => `${h.id}:${(h.title||'').trim()}`).join('|');
    if (newKey === lastSuggestionsKey) {
        return;
    }
    lastSuggestionsKey = newKey;
    
    suggestionsDiv.innerHTML = sorted.map(h => {
        const safeTitle = (h.title && String(h.title).trim()) ? h.title : `Høring ${h.id}`;
        const deadline = h.deadline ? formatDeadlineShort(h.deadline) : 'Ingen frist';
        
        return `
            <div class="suggestion-item" data-id="${h.id}" onclick="window.handleSelectHearingFromSearch(${h.id})">
                <div class="suggestion-content">
                    <div class="suggestion-title">${safeTitle}</div>
                    <div class="suggestion-meta">
                        <span>ID: ${h.id}</span>
                        <span>•</span>
                        <span>${deadline}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    // Position dropdown relative to input field
    if (inputEl) {
        const rect = inputEl.getBoundingClientRect();
        suggestionsDiv.style.position = 'fixed';
        suggestionsDiv.style.top = `${rect.bottom + 4}px`;
        suggestionsDiv.style.left = `${rect.left}px`;
        suggestionsDiv.style.width = `${rect.width}px`;
        suggestionsDiv.style.backgroundColor = 'var(--color-white)';
        suggestionsDiv.style.border = '1px solid var(--color-gray-300)';
        suggestionsDiv.style.borderRadius = 'var(--radius-sm)';
        suggestionsDiv.style.boxShadow = 'var(--shadow-lg)';
        suggestionsDiv.style.maxHeight = '400px';
        suggestionsDiv.style.overflowY = 'auto';
        suggestionsDiv.style.zIndex = '10001';
    }
    
    suggestionsDiv.style.display = 'block';
}

function hideSuggestions() {
    const el = document.getElementById('hearing-search-suggestions');
    if (!el) return;
    el.style.display = 'none';
    lastSuggestionsKey = '';
}

window.handleSelectHearingFromSearch = async function(hearingId) {
    const input = document.getElementById('hearing-search-input');
    if (input) input.value = '';
    hideSuggestions();
    await handleFetchHearingById(hearingId);
};

function setupHearingSearch(input) {
    input.addEventListener('input', async () => {
        clearTimeout(searchTimeout);
        const query = input.value.trim();
        
        if (query.length < 2) {
            hideSuggestions();
            return;
        }
        
        searchTimeout = setTimeout(async () => {
            const token = ++currentSearchToken;
            try {
                const latest = input.value.trim();
                if (latest !== query) return;
                
                const localResults = await searchLocally(query);
                displaySuggestions(localResults || []);
            } catch (error) {
                if (error && error.name === 'AbortError') return;
                console.error('Search error:', error);
            }
        }, 100);
    });
    
    input.addEventListener('keydown', async (e) => {
        if (e.key === 'Escape') {
            hideSuggestions();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const query = input.value.trim();
            if (!query) return;
            
            // If it's a number, fetch directly
            if (/^\d+$/.test(query)) {
                hideSuggestions();
                await handleFetchHearingById(query);
                return;
            }
            
            // Otherwise, select first suggestion if available
            const firstItem = document.querySelector('#hearing-search-suggestions .suggestion-item');
            if (firstItem) {
                const hearingId = Number(firstItem.dataset.id);
                if (hearingId) {
                    hideSuggestions();
                    input.value = '';
                    await handleFetchHearingById(String(hearingId));
                }
            }
        }
    });
}

async function handleFetchHearingById(hearingIdParam) {
    const hearingId = hearingIdParam || document.getElementById('hearing-search-input')?.value?.trim();
    if (!hearingId || !/^\d+$/.test(hearingId)) {
        showError('Indtast et gyldigt hørings-ID');
        return;
    }
    const id = Number(hearingId);
    
    // Close modal immediately
    const settingsModalBackdrop = document.getElementById('settings-modal-backdrop');
    if (settingsModalBackdrop) {
        settingsModalBackdrop.classList.remove('show');
    }
    
    const hearingSearchInput = document.getElementById('hearing-search-input');
    if (hearingSearchInput) {
        hearingSearchInput.value = '';
        hearingSearchInput.disabled = true;
    }
    hideSuggestions();
    
    // Step 0: Try to find hearing in search index or already loaded hearings to get metadata immediately
    let indexHearing = null;
    if (cachedSearchIndex && cachedSearchIndex.length > 0) {
        indexHearing = cachedSearchIndex.find(h => Number(h.id) === id);
    }
    if (!indexHearing && state.hearings.length > 0) {
        indexHearing = state.hearings.find(h => Number(h.hearingId || h.id) === id);
    }
    
    // If not found in cache, try to fetch from API search index
    if (!indexHearing) {
        try {
            const searchResults = await fetchJson(`/api/hearing-index?db=1&q=${encodeURIComponent(id)}`).catch(() => null);
            if (searchResults && Array.isArray(searchResults.hearings)) {
                indexHearing = searchResults.hearings.find(h => Number(h.id) === id);
            }
        } catch (e) {
            // Ignore errors
        }
    }
    
    // Add hearing to list immediately with index data (or placeholder) so it appears right away
    const existingIndex = state.hearings.findIndex(h => Number(h.hearingId) === id);
    if (existingIndex < 0) {
        const hearingItem = {
            hearingId: id,
            id: id,
            title: indexHearing?.title || `Høring ${id}`,
            deadline: indexHearing?.deadline || null,
            status: indexHearing?.status || 'ukendt',
            preparation: {
                status: 'loading',
                responsesReady: false,
                materialsReady: false
            },
            counts: {
                rawResponses: 0,
                preparedResponses: 0,
                publishedResponses: 0
            },
            isLoading: true
        };
        state.hearings.push(hearingItem);
        await saveHearingToServer(id);
        renderHearingList();
    } else {
        // Mark existing as loading
        state.hearings[existingIndex].isLoading = true;
        renderHearingList();
    }
    
    // Mark hearing as current
    state.currentId = id;
    
    // Show loading indicator on main page immediately
    showLoadingIndicator({
        steps: ['Henter høringsdata...', 'Henter svar...', 'Indlæser...'],
        current: 0,
        total: 3
    });
    
    try {
        // Step 1: Try to fetch hearing first - if it exists in DB, use it directly
        let hearingExists = false;
        let existingBundle = null;
        try {
            existingBundle = await fetchJson(`/api/gdpr/hearing/${id}`);
            if (existingBundle && existingBundle.hearing) {
                // Check if we actually have responses - if not, we need to fetch them
                const hasResponses = existingBundle.raw && Array.isArray(existingBundle.raw.responses) && existingBundle.raw.responses.length > 0;
                
                if (hasResponses) {
                    hearingExists = true;
                    // If we have existing data with responses, use it directly without refresh-raw
                    // This handles the case where cronjob has already fetched the responses
                    console.log('Hearing found in database with responses, using existing data');
                    
                    // Update hearing in list with actual data
                    await addOrUpdateHearingInList(id);
                    await selectHearing(id);
                    
                    // Remove loading state
                    const hearingIndex = state.hearings.findIndex(h => Number(h.hearingId) === id);
                    if (hearingIndex >= 0) {
                        state.hearings[hearingIndex].isLoading = false;
                        renderHearingList();
                    }
                    
                    setTimeout(() => {
                        showSuccess('Høring er indlæst fra databasen.');
                    }, 300);
                    
                    return; // Exit early - we already have the data
                } else {
                    // Hearing exists but no responses - need to fetch them
                    console.log('Hearing found in database but no responses, will fetch them');
                }
            }
        } catch (getError) {
            // Hearing doesn't exist yet, we'll hydrate it below
            console.log('Hearing not found in database, will hydrate...');
        }
        
        // Step 2: Hearing doesn't exist in DB, so fetch it fresh
        // This will hydrate the hearing if it doesn't exist
        showLoadingIndicator({
            steps: ['Henter høringsdata...', 'Henter svar...', 'Indlæser...'],
            current: 1,
            total: 3,
            progressText: ''
        });
        
        startRefreshProgressTracking(id);
        
        const refreshStartTime = Date.now();
        
        try {
            await fetchJson(`/api/gdpr/hearing/${id}/refresh-raw`, { method: 'POST' });
        } catch (refreshError) {
            // If refresh-raw fails, try reset which also hydrates
            console.log('refresh-raw failed, trying reset...');
            try {
                await fetchJson(`/api/gdpr/hearing/${id}/reset`, { method: 'POST' });
            } catch (resetError) {
                stopRefreshProgressTracking();
                // Remove loading state from hearing
                const hearingIndex = state.hearings.findIndex(h => Number(h.hearingId) === id);
                if (hearingIndex >= 0) {
                    state.hearings[hearingIndex].isLoading = false;
                }
                renderHearingList();
                throw new Error(`Kunne ikke hente høring ${id}. Tjek at høringen findes på blivhørt.`);
            }
        }
        
        // Keep tracking for a bit after refresh-raw completes, as server may still be saving
        const elapsed = Date.now() - refreshStartTime;
        if (elapsed < 2000) {
            // If it completed very quickly, wait a bit more for data to be saved
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        stopRefreshProgressTracking();
        
        // Step 3: Add hearing to list and select
        showLoadingIndicator({
            steps: ['Henter høringsdata...', 'Henter svar...', 'Indlæser...'],
            current: 2,
            total: 3
        });
        
        // Add or update the single hearing in the list instead of loading all
        await addOrUpdateHearingInList(id);
        await selectHearing(id);
        
        setTimeout(() => {
            showSuccess('Høringssvar er hentet og høringen er tilføjet til listen.');
        }, 300);
    } catch (error) {
        console.error('Error fetching hearing:', error);
        const errorMsg = error.message || 'Ukendt fejl';
        
        // Remove loading state from hearing
        const hearingIndex = state.hearings.findIndex(h => Number(h.hearingId) === id);
        if (hearingIndex >= 0) {
            state.hearings[hearingIndex].isLoading = false;
            // If it's a new hearing that failed to load, remove it
            if (!state.hearings[hearingIndex].counts || state.hearings[hearingIndex].counts.rawResponses === 0) {
                state.hearings.splice(hearingIndex, 1);
                await removeHearingFromServer(id);
            }
        }
        
        if (errorMsg.includes('ikke fundet') || errorMsg.includes('not found') || errorMsg.includes('404')) {
            showError(`Høring ${id} blev ikke fundet. Kontroller at hørings-ID'et er korrekt og at høringen findes på blivhørt.`);
        } else {
            showError(`Kunne ikke hente høringssvar: ${errorMsg}`);
        }
        // Re-render list in case of error to show current state
        renderHearingList();
    } finally {
        hideLoadingIndicator();
        if (hearingSearchInput) {
            hearingSearchInput.disabled = false;
        }
        // Remove loading state
        const hearingIndex = state.hearings.findIndex(h => Number(h.hearingId) === id);
        if (hearingIndex >= 0) {
            state.hearings[hearingIndex].isLoading = false;
            renderHearingList();
        }
    }
}

function setupEventListeners() {
    // Already set up in the code above
}

init().catch(error => {
    console.error('Initialisering fejlede', error);
});

