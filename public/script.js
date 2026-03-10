const API_BASE = '/api'; // Optimized for same-domain hosting
let currentUser = null;
let isSignup = false;
let currentScheduleData = [];
let selectedTimelineSubject = '';
let selectedTimelineRange = 'week';
let timelineSubjects = [];
let selectedMonitorClassCode = '';
let cachedCheckinConfig = null;
let dropdownCache = { data: null, fetchedAt: 0 };
const DROPDOWN_CACHE_TTL_MS = 5 * 60 * 1000;
let isProfControlsCollapsed = false;
let auditLookup = { students: new Map(), classes: new Map() };

function setProfControlsCollapsed(collapsed) {
    isProfControlsCollapsed = collapsed;

    const content = document.getElementById('profControlsContent');
    const toggleBtn = document.getElementById('toggleProfControlsBtn');

    if (!content || !toggleBtn) return;

    content.style.display = collapsed ? 'none' : 'block';
    toggleBtn.textContent = collapsed ? 'Expand' : 'Collapse';
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
}

function toggleProfControlsCollapse() {
    setProfControlsCollapsed(!isProfControlsCollapsed);
    localStorage.setItem('profControlsCollapsed', JSON.stringify(isProfControlsCollapsed));
}

// API Helper
async function api(action, payload = {}) {
    const bar = document.getElementById('loading-bar');
    bar.style.width = '30%';
    try {
        const res = await fetch(API_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...payload })
        });
        bar.style.width = '100%';
        const data = await res.json();
        if (res.status === 401) signout();
        return data;
    } catch (err) {
        return { ok: false, error: err.message };
    } finally {
        setTimeout(() => bar.style.width = '0%', 500);
    }
}

async function getDropdownData(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && dropdownCache.data && (now - dropdownCache.fetchedAt) < DROPDOWN_CACHE_TTL_MS) {
        return dropdownCache.data;
    }

    const data = await api('get_dropdowns');
    if (data.ok) {
        dropdownCache = { data, fetchedAt: now };
    }
    return data;
}

document.addEventListener('DOMContentLoaded', async () => {
    const form = document.getElementById("authForm");
    const idInput = document.getElementById("userId");
    const passwordInput = document.getElementById("passwordInput");
    const roleSelect = document.getElementById("roleSelect");
    const errorMsg = document.getElementById("errorMsg");
    const submitBtn = document.getElementById("submitBtn");
    const formTitle = document.getElementById("formTitle");
    const switchText = document.getElementById("switchText");
    const authForm = document.getElementById("authForm");

    // UI Initialization
    document.getElementById('copyrightYear').textContent = new Date().getFullYear();

    // Password visibility toggle logic
    const pwd = document.getElementById('passwordInput');      
    const icon = document.getElementById('togglePassword');
    icon.addEventListener('click', () => {
      const show = pwd.type === 'password';
      pwd.type = show ? 'text' : 'password';
      // Toggle password visibility
      icon.classList.toggle('fa-eye', show);
      icon.classList.toggle('fa-eye-slash', !show);
    });

    // Toggle between Sign In / Sign Up
    switchText.addEventListener("click", (e) => {
        e.preventDefault();
        isSignup = !isSignup;
        formTitle.textContent = isSignup ? "Sign Up" : "Sign In";
        submitBtn.textContent = isSignup ? "Sign Up" : "Sign In";
        switchText.innerHTML = isSignup 
            ? 'Already have an account? <a href="#">Sign in</a>' 
            : 'Don’t have an account? <a href="#">Sign up</a>';
        errorMsg.textContent = "";
    });

    // Handle form submit
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        errorMsg.textContent = "";
        errorMsg.style.color = "red";
        submitBtn.disabled = true;
        
        if (!idInput.value.trim() || !passwordInput.value.trim() || !roleSelect.value) {
            errorMsg.textContent = 'Please fill in all fields and select a role';
            submitBtn.disabled = false;
            return;
        }

        if (isSignup && passwordInput.value.trim().length < 12) {
            errorMsg.textContent = "Password must be at least 12 characters.";
            submitBtn.disabled = false;
            return;
        }

        const authMsg = document.getElementById('authMsg');
        if (authMsg) authMsg.textContent = isSignup ? "Signing up..." : "Signing in...";
        
        try {
            const data = await api(isSignup ? "signup" : "signin", {
                id: idInput.value.trim().toUpperCase(),
                password: passwordInput.value.trim(),
                role: roleSelect.value
            });

            if (!data.ok) {
                errorMsg.textContent = data.error || (isSignup ? "Signup failed" : "Login failed");
                submitBtn.disabled = false;
                return;
            }

            if (isSignup) {
                errorMsg.style.color = "green";
                errorMsg.textContent = data.message || "Signup successful! Please sign in.";
                isSignup = false;
                formTitle.textContent = "Sign In";
                submitBtn.textContent = "Sign In";
                submitBtn.disabled = false;
                passwordInput.value = "";
            } else {
                currentUser = data.user;
                localStorage.setItem("currentUser", JSON.stringify(currentUser));
                showApp();
            }
        } catch (err) {
            errorMsg.textContent = "Network error: " + err.message;
            submitBtn.disabled = false;
        } finally {
            if (authMsg) setTimeout(() => authMsg.textContent = "", 1000);
        }
    });
    
    // --- Check for Holiday ---
    async function checkHolidayAndDisplay() {
        const el = document.getElementById('holidayNotice');
        if (!el) return;
    
        try {
            const res = await api('check_holiday', {});
            if (res.ok && res.isHoliday) {
                el.innerHTML = `<div class="pill danger" style="margin-bottom:15px; display:block; text-align:center;">
                    🎉 ${res.holidayName}! (${res.holidayType})
                </div>`;
            } else {
                el.innerHTML = '';
            }
        } catch (err) {
            console.error("Holiday check failed", err);
        }
    }

    // Live Search Logic
    document.getElementById('studentSearch').addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        const listItems = document.querySelectorAll('#recentCheckinList li');
        let found = false;
    
        listItems.forEach(item => {
            const name = item.textContent.toLowerCase();
            const matches = name.includes(term);
            item.style.display = matches ? 'block' : 'none';
            if (matches) found = true;
        });
    
        // Optional: Log a message if nothing is found
        // console.log(found ? "Results found" : "No matching students");
    });

    // --- Automatic Session Restore ---
    const restoreSession = () => {
        const raw = localStorage.getItem('currentUser');
        if (raw) {
            try {
                currentUser = JSON.parse(raw);
                showApp();
            } catch (e) {
                localStorage.removeItem('currentUser');
                document.getElementById('auth').style.display = 'block';
            }
        } else {
            document.getElementById('auth').style.display = 'block';
        }
    };

    const checkHealth = async () => {
        const statusEl = document.getElementById('systemStatus');
        if (!statusEl) return;
    
        const res = await api('health_check'); 
        
        if (res.ok) {
            statusEl.innerHTML = `<i class="fa fa-circle" style="color: #10b981;"></i> System Online`;
            statusEl.style.color = "#10b981"; // Emerald Green
        } else {
            statusEl.innerHTML = `<i class="fa fa-circle" style="color: #ef4444;"></i> System Offline`;
            statusEl.style.color = "#ef4444"; // Rose Red
            
            // Optional: Show error message in the main UI if it's a critical DB error
            const errorMsg = document.getElementById('errorMsg');
            if (errorMsg) errorMsg.textContent = "⚠️ Database Connection Error. Please refresh.";
        }
    };

    // Run these on load
    checkHolidayAndDisplay();
    restoreSession();

    // Check health 2 seconds after load (to let DB server wake up)
    setTimeout(checkHealth, 2000);
});

async function showApp() {
    document.getElementById('auth').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    
    // Set User Info
    document.getElementById('welcome').textContent = currentUser.name;
    document.getElementById('roleBadge').textContent = currentUser.id + " (" + currentUser.role.toUpperCase() + ")";
    
    // Control section visibility
    const controls = document.getElementById('controls');
    const isElevated = currentUser.role === 'officer' || currentUser.role === 'professor' || currentUser.role === 'admin';

    controls.style.display = 'block';
    document.getElementById('officerControls').style.display = (currentUser.role === 'officer' || currentUser.role === 'admin') ? 'block' : 'none';
    document.getElementById('studentControls').style.display = (currentUser.role === 'student' || currentUser.role === 'officer' || currentUser.role === 'admin') ? 'block' : 'none';

    // Fetch Data (Parallelized for speed). We run these at the same time but wait for ALL to finish
    await Promise.all([
        loadTodaySchedule(),  // Hydrates currentScheduleData
        checkGlobalStatus(),  // Renders the alert banner
        renderCycleTimeline() // Shows semester cycle progress
    ]);
    
    // Show both the Live Monitor and Summary to Professors AND Officers
    document.getElementById('profControls').style.display = isElevated ? 'block' : 'none';

    if (isElevated) {
        const savedCollapsedState = localStorage.getItem('profControlsCollapsed');
        const shouldCollapse = savedCollapsedState ? JSON.parse(savedCollapsedState) : true;
        setProfControlsCollapsed(shouldCollapse);
    }

    if (isElevated) {
        const monitorFilter = document.getElementById('monitorClassFilter');
        if (monitorFilter && !monitorFilter.dataset.bound) {
            monitorFilter.addEventListener('change', async (event) => {
                selectedMonitorClassCode = event.target.value;
                await loadProfessorDashboard();
            });
            monitorFilter.dataset.bound = 'true';
        }

        loadProfessorDashboard();
        populateClassDropdowns();
    }

	if (currentUser.role === 'officer' || currentUser.role === 'admin') {
		await initializeOfficerPasswordTools();
		await initializeOfficerAuditTrail();
	}
    // Call this function when the Officer view loads
    /*if (currentUser.role === 'officer' || currentUser.role === 'admin') {
        loadScheduleList();
    }*/
}

async function initializeOfficerPasswordTools() {
    const classSelect = document.getElementById('officerActionClassSelect');
    const studentSelect = document.getElementById('officerResetStudentSelect');
    const resetBtn = document.getElementById('officerResetStudentBtn');
    const creditBtn = document.getElementById('officerCreditStudentBtn');
    const dropBtn = document.getElementById('officerDropStudentBtn');
    const statusEl = document.getElementById('officerResetStatus');
    if (!classSelect || !studentSelect || !resetBtn || !creditBtn || !dropBtn || !statusEl) return;

    statusEl.textContent = 'Loading classes and students...';

    const data = await getDropdownData();
    if (!data.ok) {
        statusEl.textContent = 'Unable to load classes/students right now.';
        return;
    }

    classSelect.innerHTML = `<option value="">Select Class</option>${(data.classes || []).map(c => `<option value="${c.code}">${c.code} • ${c.name}</option>`).join('')}`;
    studentSelect.innerHTML = `<option value="">Select Student</option>${(data.students || []).map(s => `<option value="${s.user_id}">${s.user_name} [${s.user_id}]</option>`).join('')}`;
	statusEl.textContent = '';

    if (!resetBtn.dataset.bound) {
        resetBtn.addEventListener('click', async () => {
            const studentId = studentSelect.value;
            if (!studentId) {
                statusEl.textContent = 'Please select a student first.';
                return;
            }

            statusEl.textContent = 'Generating temporary password...';
            const success = await reset_single_password(studentId);
            statusEl.textContent = success
                ? `Password reset complete for ${studentId}.`
                : 'Password reset failed. Please try again.';
        });

        const runStatusUpdate = async (type) => {
            const classCode = classSelect.value;
            const studentId = studentSelect.value;
            if (!classCode || !studentId) {
                statusEl.textContent = 'Please select both class and student first.';
                return;
            }

            const success = await applyOfficerClassStatusUpdate(classCode, studentId, type);
            statusEl.textContent = success
                ? `${type === 'CREDITED' ? 'Credited' : 'Dropped'} ${studentId} for ${classCode}.`
                : `Unable to ${type === 'CREDITED' ? 'credit' : 'drop'} ${studentId}.`;
        };

        creditBtn.addEventListener('click', () => runStatusUpdate('CREDITED'));
        dropBtn.addEventListener('click', () => runStatusUpdate('DROPPED'));

        resetBtn.dataset.bound = 'true';
    }
}

async function initializeOfficerAuditTrail() {
    const classFilter = document.getElementById('auditClassFilter');
    const studentFilter = document.getElementById('auditStudentFilter');
    const dateFilter = document.getElementById('auditDateFilter');
    const applyBtn = document.getElementById('auditApplyBtn');
    const clearBtn = document.getElementById('auditClearBtn');
    if (!classFilter || !studentFilter || !dateFilter || !applyBtn || !clearBtn) return;

    const data = await getDropdownData();
    if (!data.ok) {
        document.getElementById('auditTrailMeta').textContent = 'Unable to load filter options right now.';
        return;
    }

    auditLookup.students = new Map((data.students || []).map(s => [s.user_id, s.user_name]));
    auditLookup.classes = new Map((data.classes || []).map(c => [c.code, c.name]));

    classFilter.innerHTML = `<option value="">All Classes</option>${(data.classes || []).map(c => `<option value="${c.code}">${c.code} • ${c.name}</option>`).join('')}`;
    studentFilter.innerHTML = `<option value="">All Students</option>${(data.students || []).map(s => `<option value="${s.user_id}">${s.user_name} [${s.user_id}]</option>`).join('')}`;

    dateFilter.value = luxon.DateTime.now().setZone('Asia/Manila').toISODate();

    if (!applyBtn.dataset.bound) {
        applyBtn.addEventListener('click', loadOfficerAuditTrail);
        clearBtn.addEventListener('click', () => {
            classFilter.value = '';
            studentFilter.value = '';
            dateFilter.value = '';
            loadOfficerAuditTrail();
        });
        [classFilter, studentFilter, dateFilter].forEach(el => {
            el.addEventListener('change', loadOfficerAuditTrail);
        });
        applyBtn.dataset.bound = 'true';
    }

    await loadOfficerAuditTrail();
}

async function loadOfficerAuditTrail() {
    const classCode = document.getElementById('auditClassFilter')?.value || '';
    const studentId = document.getElementById('auditStudentFilter')?.value || '';
    const classDate = document.getElementById('auditDateFilter')?.value || '';
    const tbody = document.getElementById('auditTrailBody');
    const meta = document.getElementById('auditTrailMeta');
    if (!tbody || !meta) return;

    tbody.innerHTML = '<tr><td colspan="7" class="small muted">Loading attendance transaction history...</td></tr>';

    const payload = { limit: 200 };
    if (classCode) payload.class_code = classCode;
    if (studentId) payload.student_id = studentId;
    if (classDate) payload.class_date = classDate;

    const res = await api('get_attendance_transactions', payload);
    if (!res.ok) {
        tbody.innerHTML = `<tr><td colspan="7" class="small" style="color:#b91c1c;">${res.error || 'Failed to load audit trail.'}</td></tr>`;
        meta.textContent = 'Audit trail unavailable.';
        return;
    }

    const records = res.records || [];
    meta.textContent = `Showing ${records.length} transaction(s)${classDate ? ` for ${classDate}` : ''}.`;

    if (records.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="small muted">No attendance transactions found for the selected filters.</td></tr>';
        return;
    }

	const normalizeAuditField = value => {
        if (value === null || value === undefined) return null;
        const trimmed = String(value).trim();
        if (!trimmed) return null;
        const normalized = trimmed.toLowerCase();
        return ['undefined', 'null', 'nan'].includes(normalized) ? null : trimmed;
    };

    tbody.innerHTML = records.map(record => {
        const stamp = new Date(record.transaction_time).toLocaleString();
        const studentName = auditLookup.students.get(record.student_id) || record.student_id;
        const className = auditLookup.classes.get(record.class_code) || '';
		const normalizedActorId = normalizeAuditField(record.actor_id);
        const normalizedActorName = normalizeAuditField(record.actor_name);
        const actorDisplay = normalizedActorName
            ? `${normalizedActorName}${normalizedActorId ? `<div class="small muted">${normalizedActorId}</div>` : ''}`
            : (normalizedActorId || '-');
        const reason = record.reason || '-';
		const dateTimeString = new Date(record.class_date.split("T")[0] + "T" + record.time_in).toLocaleString("en-US", { hour12: true });
        return `
            <tr>
                <td>${dateTimeString}</td>
                <td>${studentName}<div class="small muted">${record.student_id}</div></td>
                <td>${record.class_code}${className ? `<div class="small muted">${className}</div>` : ''}</td>
                <td>${record.event_type || '-'}</td>
                <td>${record.attendance_status || '-'}</td>
                <td>${actorDisplay}</td>
                <td>${reason}</td>
				<td>${stamp}</td>
            </tr>
        `;
    }).join('');
}

function parseMinutesFromDisplayTime(displayTime) {
    const parsed = luxon.DateTime.fromFormat(displayTime, 'hh:mm a');
    return parsed.isValid ? (parsed.hour * 60) + parsed.minute : null;
}

function getDefaultMonitorClassCode(schedule = []) {
    if (!schedule.length) return '';

    const now = luxon.DateTime.now().setZone('Asia/Manila');
    const nowMinutes = (now.hour * 60) + now.minute;

    const enriched = schedule
        .map(cls => {
            const startMinutes = parseMinutesFromDisplayTime(cls.start_time);
            const endMinutes = parseMinutesFromDisplayTime(cls.end_time);
            return { ...cls, startMinutes, endMinutes };
        })
        .filter(cls => cls.startMinutes !== null && cls.endMinutes !== null);

    const activeClass = enriched.find(cls => nowMinutes >= cls.startMinutes && nowMinutes <= cls.endMinutes);
    if (activeClass) return activeClass.class_code;

    const upcomingClass = enriched.find(cls => cls.startMinutes > nowMinutes);
    if (upcomingClass) return upcomingClass.class_code;

    return schedule[0].class_code;
}

function renderMonitorClassFilter() {
    const wrapper = document.getElementById('monitorClassFilterWrapper');
    const select = document.getElementById('monitorClassFilter');
    if (!wrapper || !select) return;

    if (!currentScheduleData.length) {
        wrapper.style.display = 'none';
        select.innerHTML = '';
        selectedMonitorClassCode = '';
        return;
    }

    const uniqueClasses = currentScheduleData.filter((cls, idx, arr) =>
        arr.findIndex(item => item.class_code === cls.class_code) === idx
    );

    if (!selectedMonitorClassCode || !uniqueClasses.some(cls => cls.class_code === selectedMonitorClassCode)) {
        selectedMonitorClassCode = getDefaultMonitorClassCode(uniqueClasses);
    }

    select.innerHTML = uniqueClasses.map(cls => `
        <option value="${cls.class_code}" ${cls.class_code === selectedMonitorClassCode ? 'selected' : ''}>
            ${cls.class_code} • ${cls.start_time} - ${cls.end_time}
        </option>
    `).join('');

    wrapper.style.display = 'block';
}

async function loadProfessorDashboard() {
    const container = document.getElementById('profDashboardOutput');
    const searchWrapper = document.getElementById('searchWrapper');
    const classCode = selectedMonitorClassCode || currentScheduleData?.[0]?.class_code || '';
    
    // 1. Check if we have any classes loaded in our global state
    if (!currentScheduleData || currentScheduleData.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding: 20px; background: #f8fafc; border-radius: 8px; border: 1px dashed #cbd5e1;">
                <p style="margin:0;">No active class session for <strong>today's schedule</strong>.</p>
                <span class="small muted">Live stats will appear once the class starts.</span>
            </div>`;
        if (searchWrapper) searchWrapper.style.display = 'none'; // Hide if no data
        return;
    }

	if (!classCode) {
        container.innerHTML = '<div class="small muted">No class selected for monitoring.</div>';
        if (searchWrapper) searchWrapper.style.display = 'none';
        return;
    }

    const [res, totalsRes] = await Promise.all([
        api('prof_dashboard', { class_code: classCode }),
        api('prof_summary', { class_code: classCode })
    ]);

    const totalsByStudent = new Map();
    if (totalsRes?.ok && Array.isArray(totalsRes.summary)) {
        totalsRes.summary.forEach((row) => {
            if (!row.user_id) return;
            totalsByStudent.set(row.user_id, {
                present: Number(row.present_count || 0),
                late: Number(row.late_count || 0),
                absent: Number(row.absent_count || 0)
            });
        });
    }
	
    if (res.ok) {
        const hasActiveSession = res.is_makeup_session || res.is_regular_day;
        if (!hasActiveSession) {
            container.innerHTML = `
                <div style="text-align:center; padding: 20px; background: #f8fafc; border-radius: 8px; border: 1px dashed #cbd5e1;">
                    <p style="margin:0;">No active class session for <strong>${classCode}</strong> today.</p>
                    <span class="small muted">Live stats will appear once the class starts.</span>
                </div>`;
            if (searchWrapper) searchWrapper.style.display = 'none';
            return;
        }
		
        if (searchWrapper) searchWrapper.style.display = 'block';	// Show search wrapper now that we have a roster to search through

        // 4. Render Live Dashboard where each student row includes history + totals
        renderLiveDashboard(container, res, classCode, totalsByStudent);
        document.getElementById('studentSearch').dispatchEvent(new Event('input'));		// Ensure search filter works after re-rendering
    }
}

function parseClassStartDateTime(startTime, now) {
    let parsed = luxon.DateTime.fromFormat(startTime, 'HH:mm:ss');
    if (!parsed.isValid) parsed = luxon.DateTime.fromFormat(startTime, 'h:mm a');
    if (!parsed.isValid) return null;

    return parsed.set({
        year: now.year,
        month: now.month,
        day: now.day
    });
}

async function getCheckinConfig() {
    if (cachedCheckinConfig) return cachedCheckinConfig;

    const configRes = await api('getConfig');
    if (!configRes?.ok || !configRes.config) return null;

    cachedCheckinConfig = configRes.config;
    return cachedCheckinConfig;
}

async function hasActiveCheckinWindow() {
    if (!Array.isArray(currentScheduleData) || currentScheduleData.length === 0) return false;

    const config = await getCheckinConfig();
    if (!config) return true; // Fallback: keep refresh behavior if config is unavailable.

    const now = luxon.DateTime.now().setZone('Asia/Manila');
    return currentScheduleData.some((cls) => {
        const startTime = parseClassStartDateTime(cls.start_time, now);
        if (!startTime) return false;

        const enableFrom = startTime.minus({ minutes: config.checkin_window_minutes });
        const absentThreshold = startTime.plus({ minutes: config.absent_window_minutes });
        return now >= enableFrom && now <= absentThreshold;
    });
}

function renderLiveDashboard(container, res, classCode, totalsByStudent = new Map()) {
    // Calculate total students in the roster
    const totalStudents = res.roster.length;

    // Generate HTML for the Stats Cards
    let html = `
        <div style="margin-bottom: 10px; font-weight: bold; color: #1e293b;">
            Monitoring: ${classCode}
        </div>
        <div class="grid">
            ${res.stats.map(s => `
                <div class="card" style="border-left: 4px solid ${s.status === 'PRESENT' ? '#10b981' : s.status === 'ABSENT' ? '#ef4444' : '#f59e0b'}; padding: 10px; margin: 0;">
                    <div class="small muted">${s.status}</div>
                    <strong style="font-size: 1.2rem;">${s.count}</strong>
                </div>
            `).join('')}
        </div>
        
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:20px; margin-bottom:10px;">
            <h5 style="margin:0; display:flex; align-items:center; gap:8px;">
                Live Roster 
                <span style="background:#e2e8f0; color:#475569; padding:2px 8px; border-radius:10px; font-size:10px;">
                    ${totalStudents} Students
                </span>
            </h5>
            <div class="small" style="color:#10b981; font-size:10px; font-weight:bold;">
                <i class="fa fa-circle fa-circle-pulse" style="font-size:8px; vertical-align:middle;"></i> LIVE
            </div>
        </div>
        
        <ul id="recentCheckinList" class="small" style="list-style: none; padding: 0;">
    `;

    // Populate the list rows
    res.roster.forEach(r => {
        let statusColor = "#94a3b8"; 
        let opacity = r.status === 'NOT YET ARRIVED' ? "0.6" : "1";
        // Define conditions for disabling buttons
        const isCredited = r.status === 'CREDITED';
        const isDropped = r.status === 'DROPPED';
        const isMakeup = r.status === 'PENDING' || r.is_makeup_session;

        if (r.status === 'PRESENT') statusColor = "#10b981";
        if (r.status === 'LATE') statusColor = "#f59e0b";
        if (r.status === 'ABSENT') statusColor = "#ef4444";
        if (r.status === 'EXCUSED') statusColor = "#3b82f6";
        if (isCredited) statusColor = "#064e3b";
        if (isDropped) statusColor = "#ef4444";

        html += `
            <li style="padding: 10px 0; border-bottom: 1px solid #f1f5f9; opacity: ${opacity};">
                <div class="live-roster-row">
                    <span class="live-roster-details">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <div style="word-break: break-all;">
                                <strong>${r.user_name}</strong>
                                ${isMakeup ? `<span style="font-size:8px; background:#f0fdf4; color:#166534; border:1px solid #bbf7d0; padding:1px 4px; border-radius:4px;">MAKE-UP</span>` : ''}
                                <span style="font-size:9px; padding:2px 6px; border-radius:10px; background:#f1f5f9; color:${statusColor}; font-weight:bold; border: 1px solid">${r.status}</span>
                            </div>
                        </div>
                        <div class="small muted">${r.time_in ? 'In at ' + r.time_in : 'No time recorded'}</div>
                    </span>
					<div class="live-roster-actions">
                        <button onclick="showAttendanceHistory('${classCode}', '${r.user_id}')" title="View Attendance History" style="background:#eef2ff; color:#3730a3; border:1px solid #c7d2fe; padding:4px 8px; font-size:10px; border-radius:4px;">
                            History
                        </button>
						<span style="padding:2px 6px; border-radius:999px; background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; font-weight:600; font-size:9px;">P ${(totalsByStudent.get(r.user_id)?.present ?? 0)}</span>
                        <span style="padding:2px 6px; border-radius:999px; background:#fffbeb; color:#b45309; border:1px solid #fde68a; font-weight:600; font-size:9px;">L ${(totalsByStudent.get(r.user_id)?.late ?? 0)}</span>
                        <span style="padding:2px 6px; border-radius:999px; background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; font-weight:600; font-size:9px;">A ${(totalsByStudent.get(r.user_id)?.absent ?? 0)}</span>
                    </div>
                </div>
            </li>`;
		/* <div class="live-roster-actions">
                        <button onclick="bulkStatusUpdate('${r.user_id}', 'CREDITED')" ${isCredited || isDropped ? 'disabled' : ''} title="Credit Rest of Semester" style="background:#064e3b; color:white; border:none; padding:4px 8px; font-size:10px; border-radius:4px;">
                            Credit
                        </button>
                        <button onclick="bulkStatusUpdate('${r.user_id}', 'DROPPED')" ${isDropped || isCredited ? 'disabled' : ''} title="Mark as Dropped" style="background:none; color:#ef4444; border:1px solid #ef4444; padding:4px 8px; font-size:10px; border-radius:4px;">
                            Drop
                        </button>
                        <button onclick="showAttendanceHistory('${classCode}', '${r.user_id}')" title="View Attendance History" style="background:#eef2ff; color:#3730a3; border:1px solid #c7d2fe; padding:4px 8px; font-size:10px; border-radius:4px;">
                            History
                        </button>
                        <button onclick="reset_single_password('${r.user_id}')" title="Reset Password" style="background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; padding:4px 8px; font-size:10px; border-radius:4px;">
                            <i class="fa fa-key"></i>
                        </button>
                    </div>
		*/
    });

    html += `</ul>`;
    container.innerHTML = html;
}

async function showAttendanceHistory(classCode, studentId) {
    const res = await api('get_attendance_transactions', {
        class_code: classCode,
        student_id: studentId,
        limit: 10
    });

    if (!res.ok || !res.records || res.records.length === 0) {
        alert('No transaction records found for this student yet.');
        return;
    }

    const rows = res.records.map((r, idx) => {
        const time = new Date(r.transaction_time).toLocaleString();
        const reason = r.reason ? ` | ${r.reason}` : '';
        return `${idx + 1}. [${time}] ${r.event_type} → ${r.attendance_status || 'N/A'}${reason}`;
    });

    alert(`Attendance Transaction History\n\n${rows.join('\n')}`);
}

async function renderCycleTimeline() {
    const container = document.getElementById('cycleTimelineContainer');
    if (!container) return;

    container.innerHTML = '<div class="small muted">Loading cycle calendar...</div>';

    const payload = selectedTimelineSubject ? { subject_code: selectedTimelineSubject } : {};
    const res = await api('get_cycle_calendar', payload);

    if (!res.ok || !res.semester || !res.cycles || res.cycles.length === 0) {
        container.innerHTML = '';
        return;
    }

    timelineSubjects = res.subjects || [];

    const today = luxon.DateTime.now().setZone('Asia/Manila').startOf('day');
    const semesterStart = luxon.DateTime.fromISO(res.semester.start_date).startOf('day');
    const semesterEnd = luxon.DateTime.fromISO(res.semester.end_date).endOf('day');

    const rangeWindows = {
        week: {
            start: today.startOf('week'),
            end: today.endOf('week'),
            label: 'This Week'
        },
        month: {
            start: today.startOf('month'),
            end: today.endOf('month'),
            label: 'This Month'
        },
        semester: {
            start: semesterStart,
            end: semesterEnd,
            label: 'Full Semester'
        }
    };

    const selectedWindow = rangeWindows[selectedTimelineRange] || rangeWindows.week;
    const timelineStart = selectedWindow.start < semesterStart ? semesterStart : selectedWindow.start;
    const timelineEnd = selectedWindow.end > semesterEnd ? semesterEnd : selectedWindow.end;
    const totalDays = Math.max(timelineEnd.diff(timelineStart, 'days').days, 1);

    const rows = res.cycles.map(cycle => ({
        ...cycle,
        assignmentsText: (cycle.assignments || [])
            .map(item => `${item.class_code} - ${item.class_name} (${item.professor_name || 'TBD'})`)
            .join(' | '),
        windows: (cycle.windows || []).map(window => {
            const start = luxon.DateTime.fromISO(window.start).startOf('day');
            const end = luxon.DateTime.fromISO(window.end).endOf('day');
            const clippedStart = start < timelineStart ? timelineStart : start;
            const clippedEnd = end > timelineEnd ? timelineEnd : end;
            const isVisible = clippedEnd >= timelineStart && clippedStart <= timelineEnd;
            const left = Math.min(Math.max(clippedStart.diff(timelineStart, 'days').days / totalDays, 0), 1) * 100;
            const width = Math.max((clippedEnd.diff(clippedStart, 'days').days / totalDays) * 100, 0.7);
            const isActive = today >= start && today <= end;
            return { ...window, start, end, left, width, isActive, isVisible };
        })
    })).filter(cycle => cycle.windows.some(window => window.isVisible));

    const monthMarks = [];
    let monthCursor = timelineStart.startOf('month');
    while (monthCursor <= timelineEnd) {
        const left = Math.min(Math.max(monthCursor.diff(timelineStart, 'days').days / totalDays, 0), 1) * 100;
        monthMarks.push({ label: monthCursor.toFormat('LLL'), left });
        monthCursor = monthCursor.plus({ months: 1 });
    }

    const markerOffset = Math.min(Math.max(today.diff(timelineStart, 'days').days / totalDays, 0), 1) * 100;
    const activeWindows = rows.flatMap(cycle =>
        cycle.windows
            .filter(window => window.isVisible && window.isActive)
            .map(window => ({ ...window, cycleName: cycle.cycle_name }))
    );

    let statusText = 'Today is outside the active cycle windows.';
    if (activeWindows.length > 0) {
        const modeBuckets = activeWindows.reduce((bucket, window) => {
            const modeLabel = window.mode === 'sync' ? 'Synchronous' : 'Asynchronous';
            if (!bucket[modeLabel]) bucket[modeLabel] = [];
            bucket[modeLabel].push(`<strong>${window.cycleName}</strong>`);
            return bucket;
        }, {});

        const statusSegments = Object.entries(modeBuckets)
            .map(([modeLabel, cycles]) => `${modeLabel} for ${cycles.join(', ')}`);

        statusText = statusSegments.length === 1
            ? `Today is <strong>${statusSegments[0]}</strong>.`
            : `Today is <strong>${statusSegments.join('</strong> and <strong>')}</strong>.`;
    };

    const optionsHtml = ['<option value="">All Subjects</option>']
        .concat(timelineSubjects.map(subject =>
            `<option value="${subject.code}" ${selectedTimelineSubject === subject.code ? 'selected' : ''}>${subject.code}</option>`
        ))
        .join('');

    const rangeOptionsHtml = Object.entries(rangeWindows)
        .map(([value, range]) => `<option value="${value}" ${selectedTimelineRange === value ? 'selected' : ''}>${range.label}</option>`)
        .join('');

    const timelineRangeLabel = `${timelineStart.toFormat('LLL dd, yyyy')} - ${timelineEnd.toFormat('LLL dd, yyyy')}`;

    const rowsHtml = rows.map(cycle => `
        <div class="cycle-row">
            <div class="cycle-label">${cycle.cycle_name}</div>
            <div class="cycle-track">
                ${cycle.windows.filter(window => window.isVisible).map(window => `
                    <span
                        class="cycle-window ${window.mode} ${window.isActive ? 'is-active' : ''}"
                        style="left:${window.left}%; width:${window.width}%;"
                        title="${cycle.cycle_name} · ${window.mode === 'sync' ? 'Synchronous' : 'Asynchronous'} · ${window.start.toFormat('LLL dd')} - ${window.end.toFormat('LLL dd')}&#10;"
                    ></span>
                `).join('')}
                <span class="cycle-now-marker" style="left: calc(${markerOffset}% - 1px);"></span>
            </div>
        </div>
    `).join('');

    container.innerHTML = `
        <div class="cycle-timeline-card">
            <div class="cycle-topbar">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex:1; min-width:180px;">
                    <strong style="font-size: 0.92rem; color:#7f1d1d;">Cycle Calendar</strong>
                </div>
                <label class="cycle-filter">Filter
                    <select id="cycleSubjectFilter">${optionsHtml}</select>
                </label>
                <label class="cycle-filter">Range
                    <select id="cycleRangeFilter">${rangeOptionsHtml}</select>
                </label>
            </div>
            <div class="cycle-range-head">
                <span>${(selectedWindow.label == 'Full Semester') ? res.semester.name + " " + res.semester.academic_year : selectedWindow.label + " (" + timelineRangeLabel + ")"}</span>
                <div class="cycle-month-scale">
                    ${monthMarks.map(mark => `<span class="cycle-month-tag" style="left:${mark.left}%;">${mark.label}</span>`).join('')}
                </div>
            </div>
            ${rowsHtml || '<div class="small muted" style="margin-top:8px;">No cycle windows in this timeframe.</div>'}
            <div class="small" style="color:#7f1d1d; margin-top:8px; font-size: 0.8rem;">${statusText}</div>
            <div class="cycle-legend">
                <span class="cycle-legend-item"><span class="cycle-legend-dot sync"></span>Synchronous week</span>
                <span class="cycle-legend-item"><span class="cycle-legend-dot async"></span>Asynchronous period</span>
                <span class="cycle-legend-item"><span style="width:2px;height:12px;background:#1f2937;display:inline-block;border-radius:999px;"></span>Today</span>
            </div>
        </div>
    `;

    const filterEl = document.getElementById('cycleSubjectFilter');
    if (filterEl) {
        filterEl.addEventListener('change', async (event) => {
            selectedTimelineSubject = event.target.value;
            await renderCycleTimeline();
        });
    }

    const rangeEl = document.getElementById('cycleRangeFilter');
    if (rangeEl) {
        rangeEl.addEventListener('change', async (event) => {
            selectedTimelineRange = event.target.value;
            await renderCycleTimeline();
        });
    }
}


async function loadTodaySchedule() {
    const list = document.getElementById('scheduleList');
    list.innerHTML = '<div class="small muted">Checking for classes...</div>';
    
    const res = await api('today_schedule', { student_id: currentUser.id });
    
    if (!res.ok) {
        currentScheduleData = [];
        list.innerHTML = '<div class="error-message">Failed to load schedule.</div>';
        renderMonitorClassFilter();
        return;
    }

    // Check if the list is empty
    if (!res.schedule || res.schedule.length === 0) {
        currentScheduleData = [];
        list.innerHTML = `
            <div class="card" style="text-align:center; padding: 40px 20px; border: 1px dashed #cbd5e1; background: #f8fafc;">
                <i class="fa fa-calendar-o" style="font-size: 2rem; color: #94a3b8; margin-bottom: 10px;"></i>
                <div class="small muted">No classes scheduled for today.</div>
                <div class="small" style="margin-top:5px; color: #64748b;">Enjoy your break!</div>
            </div>
        `;
        return;
    }

    // HYDRATE GLOBAL STATE: Store the array here
    currentScheduleData = res.schedule; 
    renderMonitorClassFilter();
    // Otherwise, clear and loop through classes
    list.innerHTML = '';
    const timeMap = {}; // To track time overlaps
    currentScheduleData.forEach(cls => {
        const timeKey = `${cls.start_time}-${cls.end_time}`;
        if (!timeMap[timeKey]) timeMap[timeKey] = [];
        timeMap[timeKey].push(cls.class_code);
        
        const isConflict = timeMap[timeKey].length > 1;

        const cycleBadge = cls.cycle_name ? 
            `<span style="background: #f1f5f9; color: #475569; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; border: 1px solid #cbd5e1; margin-left: 3px;">
                ${cls.cycle_name}
            </span>` : '';
            
        const card = document.createElement('div');
        card.className = 'class-card';
        card.innerHTML = `
            <div style="flex:1">
                <div style="display:flex; align-items:center; gap:8px;">
                    <strong>${cls.class_name} [${cls.class_code}] ${cycleBadge}</strong>
                    ${isConflict ? `<span style="background:#fee2e2; color:#b91c1c; border:1px solid #fecaca; font-size:9px; padding:1px 6px; border-radius:4px; font-weight:bold;">CONFLICT</span>` : ''}
                </div>
                <span class="small muted">${cls.start_time} - ${cls.end_time}</span>
                <div class="small muted" style="margin:5px 0">${cls.professor_name ? '<em>Professor: ' + cls.professor_name + '</em>' : '<em>Professor: TBD</em>'}</div>
                <div id="status-${cls.class_code.replace(/\s+/g, '-')}" class="small" style="margin:5px 0">Checking status...</div>
                
                <div id="excuse-area-${cls.class_code.replace(/\s+/g, '-')}" style="display:none; margin-top:10px; background:#f1f5f9; padding:8px; border-radius:8px;">
                    <input type="text" id="reason-${cls.class_code.replace(/\s+/g, '-')}" placeholder="Reason for excuse..." style="width:97%; font-size:12px; margin-bottom:5px;" minlength="5" autocomplete="off" required>
                    <button onclick="submitExcuse('${cls.class_code}')" style="font-size:11px; padding:5px 10px; background:#64748b; color:white; border:none;">Submit Excuse</button>
                </div>
            </div>
            <div class="class-actions-grid" style="display: block; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px;">
                <button class="checkin-btn" id="btn-${cls.class_code.replace(/\s+/g, '-')}" disabled 
                    style="width: 100%; margin: 0; padding: 10px; font-size: 11px;">
                    <i class="fa fa-map-marker"></i> Check In
                </button>
                
                <button class="excuse-btn" id="excuse-link-${cls.class_code.replace(/\s+/g, '-')}" 
                    onclick="toggleExcuse(event, '${cls.class_code}')"
                    style="width: 100%; margin: 8px 0; padding: 10px; font-size: 11px; background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; border-radius: 6px;">
                    <i class="fa fa-paper-plane"></i> File Excuse
                </button>
        
                <div id="self-service-container-${cls.class_code.replace(/\s+/g, '-')}" style="grid-column: span 2; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                </div>
            </div>
        `;
        list.appendChild(card);

        // Toggle the excuse input visibility
        window.toggleExcuse = (e, classCode) => {
            e.preventDefault();
            const area = document.getElementById(`excuse-area-${classCode.replace(/\s+/g, '-')}`);
            area.style.display = area.style.display === 'none' ? 'block' : 'none';
        };

        // Send the excuse to the server
        window.submitExcuse = async (classCode) => {
			const selectedClass = currentScheduleData.find(item => item.class_code === classCode);
            if (selectedClass && !selectedClass.professor_id) {
                return alert('Student transactions are disabled until a professor is assigned.');
            }
			
            // 1. Critical Check: Is classCode actually valid?
            if (!classCode || typeof classCode !== 'string') {
                console.error("Invalid classCode received:", classCode);
                return alert("Error: Class reference is missing.");
            }
        
            // 2. Sanitize carefully
            const safeCode = classCode.replace(/\s+/g, '-');
            
            // 3. Select the input
            const reasonInput = document.getElementById(`reason-${safeCode}`);
            // Null-check before accessing .value to prevent the crash
            if (!reasonInput) {
                // If it still fails, log the specific ID we looked for to help debug
                console.error(`Looking for ID: reason-${safeCode}`);
                return alert("System Error: Could not find the input field for this class.");
            }
        
            const reason = reasonInput.value.trim();
            if (reason.length < 5) return alert("Please provide a valid reason (min 5 characters).");
            
            const res = await api('submit_excuse', { 
                class_code: classCode, 
                student_id: currentUser.id, 
                reason: reason 
            });
        
            if (res.ok) {
                alert("Excuse filed! This will be included in the official Excuse Log.");
                // 1. Find the class in your local data array and update its status
                const classObj = currentScheduleData.find(c => c.class_code === classCode);
                if (classObj) {
                    classObj.my_status = 'EXCUSED'; // Lock the status locally
                    classObj.time_in = res.filedAt; // Update the local timestamp
                    classObj.reason = reason; // Save the text they just typed!
                }
        
                // 2. Re-run the UI update to hide the "File Excuse" link and inputs
                updateCheckinUI(classObj);
                
                // 3. Hide the excuse area explicitly
                const area = document.getElementById(`excuse-area-${safeCode}`);
                if (area) area.style.display = 'none';
            } else {
                alert(res.error);
            }
        };
        
        updateCheckinUI(cls);
    });
    return res; // Helpful for the caller to know it's done
}

async function saveCycle() {
    const name = document.getElementById('cycleName').value;
    const start = document.getElementById('cycleStart').value;
    const end = document.getElementById('cycleEnd').value;

    // Basic Validation
    if (!name || !start || !end) {
        alert("Please fill in all cycle details (Name, Start Date, and End Date).");
        return;
    }

    if (new Date(start) > new Date(end)) {
        alert("Start date cannot be after the end date.");
        return;
    }

    // Call your API
    const res = await api('add_academic_cycle', {
        name: name,
        start_date: start,
        end_date: end
    });

    if (res.ok) {
        alert(`${name} has been defined from ${start} to ${end}.`);
        // Clear fields
        document.getElementById('cycleName').value = '';
        document.getElementById('cycleStart').value = '';
        document.getElementById('cycleEnd').value = '';
        
        // Optional: Refresh the view if you have a list of cycles showing
        if (typeof loadCycleList === 'function') loadCycleList();
    } else {
        alert("Error saving cycle: " + res.error);
    }
}

async function populateCycleDropdown() {
    const dropdown = document.getElementById('schedCycleId');
    const res = await api('get_cycles'); // You'll need this backend route
    
    if (res.ok) {
        // Keep the "Full Semester" option and add the rest
        dropdown.innerHTML = '<option value="">Full Semester / Regular</option>';
        res.cycles.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.cycle_id;
            opt.textContent = `${c.cycle_name} (${c.start_date} to ${c.end_date})`;
            dropdown.appendChild(opt);
        });
    }
}

async function submitNewSchedule() {
    // Collect checked days
    const days = Array.from(document.querySelectorAll('#dayCheckboxes input:checked')).map(cb => cb.value);
    
    const payload = {
        class_code: document.getElementById('schedCode').value,
        course_title: document.getElementById('schedTitle').value,
        professor_id: document.getElementById('schedProfId').value,
        cycle_id: document.getElementById('schedCycleId').value || null,
        start_time: document.getElementById('schedStartTime').value,
        end_time: document.getElementById('schedEndTime').value,
        days: days
    };

    if (!payload.class_code || days.length === 0) {
        alert("Please provide at least a Class Code and select at least one day.");
        return;
    }

    const res = await api('add_schedule', payload);
    if (res.ok) {
        alert("Schedule added successfully.");
        hideModal('scheduleModal');
        // Refresh your list or dashboard
        if (currentUser.role === 'professor' || currentUser.role === 'officer' || currentUser.role === 'admin') {
            loadProfessorDashboard();
        }
    }
}

async function populateProfessors() {
    const dropdown = document.getElementById('schedProfId');
    // We assume your 'get_users' or a new 'get_profs' route exists
    const res = await api('get_profs'); 
    
    if (res.ok) {
        dropdown.innerHTML = '<option value="">Select Professor...</option>';
        res.profs.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.user_id;
            opt.textContent = `${p.user_name} (${p.user_id})`;
            dropdown.appendChild(opt);
        });
    }
}

// Function to show any modal by ID
function showModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.style.display = 'block';
        // Optional: Disable body scroll when modal is open
        document.body.style.overflow = 'hidden';
        clearModalFields(id); // Wipe it so it's clean for the next person
    }
}

// Function to hide any modal by ID
function hideModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.style.display = 'none';
        // Re-enable body scroll
        document.body.style.overflow = 'auto';
    }
}

function clearModalFields(modalContainerId) {
    document.getElementById('reportOutput').innerHTML = '';    // clear the download link
    const container = document.getElementById(modalContainerId);
    if (!container) return;

    // Clear all standard inputs
    container.querySelectorAll('input').forEach(input => {
        if (input.type === 'checkbox' || input.type === 'radio') {
            input.checked = false;
        } else {
            input.value = '';
        }
    });

    // Reset all select dropdowns to the first option
    container.querySelectorAll('select').forEach(select => {
        select.selectedIndex = 0;
    });

    // Clear any text status spans or textareas
    container.querySelectorAll('textarea').forEach(tx => tx.value = '');
    // If you use spans for labels/status, clear them too
    container.querySelectorAll('.modal-status-text').forEach(span => span.textContent = '');
}

// Keep the outside-click listener as a backup
window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = "none";
        document.body.style.overflow = 'auto';
    }
}

// Specialized function for the Schedule Creator to refresh data before opening
async function openScheduleModal() {
    showModal('scheduleModal');
    
    // Fetch fresh data for the dropdowns
    // These are important for your LGU project to ensure no outdated IDs are used
    await Promise.all([
        populateProfessors(),
        populateCycleDropdown()
    ]);
}

async function loadScheduleList() {
    const tbody = document.getElementById('scheduleTableBody');
    const countLabel = document.getElementById('scheduleCount');
    
    // No payload needed - the server knows the active semester
    const res = await api('get_all_schedules');

    if (res.ok) {
        countLabel.textContent = `${res.schedules.length} Classes Found for ${res.meta.semester}`;
        
        tbody.innerHTML = res.schedules.map(s => `
            <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 10px;">
                    <strong>${s.class_code}</strong><br>
                    <span class="small muted">${s.course_title}</span>
                </td>
                <td style="padding: 10px;">
                    ${s.cycle_name ? `<span class="badge-cycle">${s.cycle_name}</span>` : '<span class="small muted">Full Sem</span>'}
                </td>
                <td style="padding: 10px;">
                    <div class="small">${s.days.join(', ')}</div>
                    <div class="small muted">${s.start_time} - ${s.end_time}</div>
                </td>
                <td style="padding: 10px;">
                    <div class="small">${s.professor_name ? s.professor_name : ''}</div>
                </td>
                <td style="padding: 10px; text-align: center; display: flex; gap: 10px; justify-content: center;">
                    <button onclick="duplicateSchedule('${s.class_code}')" title="Duplicate" class="btn-icon">
                        <i class="fa fa-copy" style="color:#6366f1;"></i>
                    </button>
                    <button onclick="deleteSchedule('${s.class_code}')" title="Delete" class="btn-icon">
                        <i class="fa fa-trash" style="color:#ef4444;"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    }
}

async function updateCheckinUI(cls) {
    // Sanitize the class code for CSS (e.g., 'POLS 102' becomes 'POLS-102')
    const safeCode = cls.class_code.replace(/\s+/g, '-');
    const btn = document.getElementById(`btn-${safeCode}`);
    const btnContainer = document.getElementById(`btn-${safeCode}`).parentElement;
    const statusSpan = document.getElementById(`status-${safeCode}`);
    const excuseLink = document.getElementById(`excuse-link-${safeCode}`);

    const hasAssignedProfessor = Boolean(cls.professor_id);
	const classWideStatus = cls.class_status;
    const classWideReason = cls.class_reason || cls.reason || '';
    if (!hasAssignedProfessor) {
        if (btn) {
            btn.disabled = true;
            btn.style.display = 'none';
        }
        if (excuseLink) {
            excuseLink.disabled = true;
            excuseLink.style.pointerEvents = 'none';
            excuseLink.style.opacity = '0.6';
            excuseLink.title = 'Excuse filing is disabled until a professor is assigned.';
        }
    }
	
	try {
        // 1. Fetch data in parallel to save time
        const [attRes, configData] = await Promise.all([
            api('get_attendance', { class_code: cls.class_code, student_id: currentUser.id }),
            api('getConfig')
        ]);

        const record = attRes.record;
        const config = configData.config;
        const now = new Date();
        const adjustmentEnd = new Date(config.adjustment_end);
        const isWithinAdjustment = now <= adjustmentEnd;
        // 2. Handle class-wide statuses first (cancelled/suspended/holiday/async)
        if (classWideStatus && ['CANCELLED', 'SUSPENDED', 'HOLIDAY', 'ASYNCHRONOUS'].includes(classWideStatus)) {
            if (btn) btn.style.display = 'none';
            if (excuseLink) excuseLink.style.display = 'none';

            const actionGrid = document.querySelector(`#btn-${safeCode}`)?.parentElement;
            if (actionGrid) actionGrid.style.display = 'none';

            const styleMap = {
                ASYNCHRONOUS: 'background: #e0f2fe; border: 1px solid #0369a1; color: #0369a1;',
                HOLIDAY: 'background: #eff6ff; border: 1px solid #1d4ed8; color: #1d4ed8;',
                SUSPENDED: 'background: #fff7ed; border: 1px solid #c2410c; color: #9a3412;',
                CANCELLED: 'background: #fef2f2; border: 1px solid #b91c1c; color: #991b1b;'
            };

            statusSpan.innerHTML = `
                <div style="padding: 10px; border-radius: 8px; text-align: center; ${styleMap[classWideStatus] || ''}">
                    <strong><i class="fa fa-ban"></i> ${classWideStatus}</strong>
                    <div class="small" style="margin-top: 5px;">${classWideReason || 'No additional notes provided.'}</div>
                    <div class="small" style="margin-top: 3px;">Check-in and excuse filing are unavailable.</div>
                </div>
            `;
            return;
        }

        // 3. Handle already-recorded attendance first (PRESENT/LATE/etc.)
        const relaxableStatuses = ['ASYNCHRONOUS', 'ABSENT'];
        const isPendingRecord = record?.status === 'PENDING';
        const isRelaxedRecord = isPendingRecord || (isWithinAdjustment && record && relaxableStatuses.includes(record.status));

        if (record && record.status && record.status !== 'not_recorded' && !isRelaxedRecord) {
            if (btn) btn.style.display = 'none';
            if (excuseLink) excuseLink.style.display = 'none';

            const actionGrid = document.querySelector(`#btn-${safeCode}`)?.parentElement;
            if (actionGrid) actionGrid.style.display = 'none';

            const timeLabel = record.time_in && record.time_in !== '00:00:00' ? `at ${record.time_in}` : '';
            statusSpan.innerHTML = `<div style="color: #64748b;"><i class="fa fa-check-circle"></i> Registered as <strong>${record.status}</strong> ${timeLabel}</div>`;
            return;
        }

        // 4. Handle Terminal Statuses (Excused, Holiday, Credited, etc.)
        const specialStatuses = ['EXCUSED', 'SUSPENDED', 'CANCELLED', 'HOLIDAY', 'ABSENT', 'ASYNCHRONOUS', 'CREDITED', 'DROPPED'];
        const finalStatus = record?.status || cls.my_status;
        const isRelaxedSpecialStatus = isWithinAdjustment && relaxableStatuses.includes(finalStatus);
        if ((specialStatuses.includes(cls.my_status) || (record && specialStatuses.includes(record.status))) && !isRelaxedSpecialStatus) {
            const finalStatus = record?.status || cls.my_status;
            if (btn) btn.style.display = 'none';
            if (excuseLink) excuseLink.style.display = 'none';
            const timeLabel = cls.time_in && cls.time_in !== '00:00:00' ? `at ${cls.time_in}` : '';

            // Hide the entire action grid to keep the UI clean
            const actionGrid = document.querySelector(`#btn-${safeCode}`).parentElement;
            if (actionGrid) actionGrid.style.display = 'none';

            statusSpan.innerHTML = `<div style="color: #64748b;"><i class="fa fa-check-circle"></i> Registered as <strong>${finalStatus}</strong> ${timeLabel}`
            if (cls.my_status === "EXCUSED") {
                statusSpan.innerHTML += `<div style="margin-top: 4px;">
                    <a href="#" onclick="toggleReasonPreview(event, '${safeCode}')" style="font-size: 10px; color: #3b82f6; text-decoration: underline;">View Filed Reason</a>
                </div>
                <div id="reason-preview-${safeCode}" style="display: none; margin-top: 8px; padding: 8px; background: #f8fafc; border-left: 3px solid #cbd5e1; font-style: italic; font-size: 11px;">
                    "${cls.reason || 'No reason details available.'}"
                </div>`;
            } else if (cls.my_status === "ASYNCHRONOUS") {
                statusSpan.innerHTML = `
                    <div style="background: #e0f2fe; padding: 12px; border-radius: 8px; border: 1px solid #0369a1; text-align: center;">
                        <span style="color: #0369a1; font-weight: bold;">
                            <i class="fa fa-laptop"></i> ${finalStatus}
                        </span>
                        <div class="small" style="margin-top: 5px; color: #0369a1;">
                            ${cls?.reason || 'Follow professor instructions.'}
                        </div>
                    </div>
                `;
            }
            statusSpan.innerHTML += `</div>`;

            // Global toggle function
            window.toggleReasonPreview = (e, safeCode) => {
                e.preventDefault();
                const preview = document.getElementById(`reason-preview-${safeCode}`);
                if (preview) {
                    preview.style.display = preview.style.display === 'none' ? 'block' : 'none';
                    e.target.textContent = preview.style.display === 'none' ? 'View Filed Reason' : 'Hide Reason';
                }
            };
            return; 
        }
    
        // 5. Handle Self-Service (Credit/Drop)
        const selfServiceContainer = document.getElementById(`self-service-container-${safeCode}`);
        if (!record || record.status === 'not_recorded' || isRelaxedRecord) {
            selfServiceContainer.innerHTML = ''; // Clear previous
            // Credit Button
            if (isWithinAdjustment) {
                const creditBtn = document.createElement('button');
                creditBtn.innerHTML = '<i class="fa fa-certificate"></i> Credit';
                creditBtn.style.cssText = "padding: 6px; font-size: 10px; background: #e1f5f7; color: #17a2b8; border: 1px solid #17a2b8; border-radius: 6px; cursor: pointer;";
                creditBtn.onclick = () => window.handleStudentSelfUpdate(cls.class_code, 'CREDITED');
                selfServiceContainer.appendChild(creditBtn);
            }
            // Drop Button
            const dropBtn = document.createElement('button');
            dropBtn.innerHTML = '<i class="fa fa-trash"></i> Drop';
            dropBtn.style.cssText = "padding: 6px; font-size: 10px; background: #fff1f2; color: #9f1239; border: 1px solid #9f1239; border-radius: 6px; cursor: pointer;";
            if (!isWithinAdjustment) dropBtn.style.gridColumn = "span 2"; // Take full width if Credit is hidden
            dropBtn.onclick = () => window.handleStudentSelfUpdate(cls.class_code, 'DROPPED');
            selfServiceContainer.appendChild(dropBtn);

            // Handler for the clicks
            window.handleStudentSelfUpdate = async (classCode, type) => {
                const actionText = type === 'CREDITED' ? 'Credit' : 'Drop';
                const msg = `Are you sure you want to ${actionText} this course? This will mark all remaining sessions for this class for the entire semester. This action is permanent.`;
        
                if (confirm(msg)) {
                    const res = await api('credit_attendance', { 
                        class_code: classCode, 
                        student_id: currentUser.id, 
                        type: type,
                        actor_id: currentUser.id
                    });
                    alert(res.message);
                    loadTodaySchedule();
                }
            };
        }

        // 6. Handle Check-In Countdown
		if (!hasAssignedProfessor) {
            statusSpan.textContent = 'Check-in and excuse filing are disabled until a professor is assigned.';
            statusSpan.style.color = '#b45309';
            return;
        }
        renderCheckinCountdown(cls, btn, statusSpan, config);
    } catch (err) {
        console.error("UI Update Failed:", err);
        statusSpan.textContent = "Error loading status. Please refresh.";
    }
}

// Helper for Countdown to keep main function clean
function renderCheckinCountdown(cls, btn, statusSpan, config) {
    const { DateTime } = luxon;
    const safeCode = cls.class_code.replace(/\s+/g, '-');
    const intervalKey = `timer_${safeCode.replace(/-/g, '_')}`;

    const updateInTimer = () => {
        // 1. Get current time in Manila
        const now = DateTime.now().setZone('Asia/Manila');
        
        // 2. PARSE: If your DB sends "9:00 AM" instead of "09:00:00", we need to be flexible.
        let startTime = DateTime.fromFormat(cls.start_time, 'HH:mm:ss');
        // Fallback if the format is different (e.g., 'hh:mm a')
        if (!startTime.isValid) {
            startTime = DateTime.fromFormat(cls.start_time, 'h:mm a');
        }
        // ATTACH TO TODAY: Set the date to today so the math works
        startTime = startTime.set({
            year: now.year,
            month: now.month,
            day: now.day
        });

        // 3. Define the Windows
        const enableFrom = startTime.minus({ minutes: config.checkin_window_minutes });
        const absentThreshold = startTime.plus({ minutes: config.absent_window_minutes });

        // 4. Calculate diffs for display
        const minsUntilOpen = Math.ceil(enableFrom.diff(now, 'minutes').minutes);

        if (now >= enableFrom && now <= absentThreshold) {    // --- SCENARIO 1: WINDOW IS OPEN ---
            btn.disabled = false;
            btn.style.display = 'block';
            statusSpan.textContent = "Check-in window is OPEN";
            statusSpan.style.color = "#10b981";

            btn.onclick = async () => {
                btn.disabled = true;
                statusSpan.textContent = 'Verifying...';
                
                const checkRes = await api('checkin', { 
                    class_code: cls.class_code, 
                    student_id: currentUser.id 
                });
                
                if (checkRes.ok) {
                    statusSpan.textContent = `Status: ${checkRes.status}`;
                    statusSpan.style.color = "#10b981";
                    btn.style.display = 'none';
                    alert(`Confirmed! You are marked as ${checkRes.status}.`);
                    
                    updateCheckinUI(cls); 
                    if (window[intervalKey]) clearInterval(window[intervalKey]);
                } else {
                    alert(checkRes.error);
                    btn.disabled = false;
                    updateInTimer(); 
                }
            };
        } else if (now > absentThreshold) {    // --- SCENARIO 2: ABSENT (WINDOW CLOSED) ---
            btn.disabled = true;
            btn.style.display = 'none'; // Optional: hide button if they missed it
            statusSpan.textContent = "Check-in closed (Absent)";
            statusSpan.style.color = "#ef4444";
            if (window[intervalKey]) clearInterval(window[intervalKey]);
        } else {    // --- SCENARIO 3: NOT YET OPEN ---
            btn.disabled = true;
            btn.style.display = 'block'; // Keep button visible but disabled

            // Formatting the specific opening time (e.g., 8:45 AM)
            const opensAtFormatted = enableFrom.toFormat('h:mm a');
            const minsUntilOpen = Math.ceil(enableFrom.diff(now, 'minutes').minutes);
            
            // If it's very close (within the window duration), show countdown
            // Otherwise show the "Opens at" time
            statusSpan.textContent = minsUntilOpen <= config.checkin_window_minutes 
                ? `Opens in ${minsUntilOpen} min(s)` 
                : `Opens at ${opensAtFormatted}`;
            
            statusSpan.style.color = "#6b7280"; // Gray color for "Locked" state
        }
    };

    // Clean up existing timers for this class
    if (window[intervalKey]) clearInterval(window[intervalKey]);
    
    updateInTimer(); // Run immediately
    window[intervalKey] = setInterval(updateInTimer, 30000); // Update every 30 seconds
}

// Optimized Report Handler
document.getElementById('reportType').onchange = async (e) => {
    const container = document.getElementById('reportParams');
    const type = e.target.value;
    if (!type) return container.innerHTML = '';
    
    container.innerHTML = 'Loading options...';
    const data = await getDropdownData();
    
    if (type === 'class') {
        container.innerHTML = `<select id="paramId"><option value="">Select Class</option>${data.classes.map(c => `<option value="${c.code}">${c.name} [${c.code}]</option>`).join('')}</select>`;
    } else {
        container.innerHTML = `<select id="paramId"><option value="">Select Student</option>${data.students.map(s => `<option value="${s.user_id}">${s.user_name} [${s.user_id}]</option>`).join('')}</select>`;
    }
};

document.getElementById('generateReport').onclick = async () => {
    const type = document.getElementById('reportType').value;
    const param = document.getElementById('paramId')?.value;
    if (!param) return alert("Please select a target.");

    const out = document.getElementById('reportOutput');
    out.textContent = "Generating PDF...";
    
    const res = await api('report', { type, [type === 'class' ? 'class_code' : 'student_id']: param });
    if (res.ok) {
        const link = document.createElement('a');
        link.href = `data:application/pdf;base64,${res.pdfMain}`; // merge here using pdf-lib if needed
        link.download = res.filename;
        link.textContent = "Download Generated Report";
        out.innerHTML = '';
        out.appendChild(link);
    } else {
        out.textContent = res.error;
    }
};

function signout() {
    localStorage.removeItem('currentUser');
    currentUser = null;
    currentScheduleData = []; // Clear the memory
    
    // Reset UI
    document.getElementById('app').style.display = 'none';
    document.getElementById('auth').style.display = 'block';
    document.getElementById("authForm").reset();
    document.getElementById("errorMsg").textContent = "";
    
    // Reset to Sign-In mode
    isSignup = false;
    document.getElementById("formTitle").textContent = "Sign In";
    document.getElementById("submitBtn").textContent = "Sign In";
    document.getElementById("submitBtn").disabled = false;
}
document.getElementById('signoutBtn').onclick = signout;

document.getElementById('viewMyAttendance').onclick = async () => {
    const btn = document.getElementById('viewMyAttendance');
    const output = document.getElementById('myAttendanceOutput');
    
    btn.disabled = true;
    btn.textContent = "Generating PDF...";
    output.innerHTML = '<p class="small muted">Preparing your attendance history...</p>';

    try {
        const res = await api('generate_student_report', { student_id: currentUser.id });
        if (res.ok && res.pdfBase64) {
            // Create a download link
            const link = document.createElement('a');
            link.href = `data:application/pdf;base64,${res.pdfBase64}`;
            link.download = `Attendance_Report_${currentUser.name.replace(/\s+/g, '_')}.pdf`;
            link.click();
            
            output.innerHTML = '<p class="small" style="color: #10b981;">✅ Report downloaded successfully.</p>';
        } else {
            output.innerHTML = `<p class="small" style="color: #ef4444;">❌ Error: ${res.error}</p>`;
        }
    } catch (err) {
        output.innerHTML = '<p class="small" style="color: #ef4444;">❌ Failed to connect to server.</p>';
    } finally {
        btn.disabled = false;
        btn.textContent = "Download My Attendance PDF";
    }
};

function parseTimeString(timeStr) {
    const [time, modifier] = timeStr.split(' ');
    let [hours, minutes] = time.split(':');
    if (hours === '12') hours = '00';
    if (modifier === 'PM') hours = parseInt(hours, 10) + 12;
    return { hours: parseInt(hours), minutes: parseInt(minutes) };
}

async function handleBulkReset() {
    const confirmation = confirm("WARNING: This will reset ALL student passwords to 'password1234'. Are you sure you want to proceed?");
    
    if (confirmation) {
        const res = await api('bulk_password_reset', { role: currentUser.role });
        if (res.ok) {
            alert(res.message);
        } else {
            alert("Error: " + res.error);
        }
    }
}

async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }

        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        return copied;
    } catch (_) {
        return false;
    }
}

window.reset_single_password = async (studentId) => {
    if (!studentId) {
        alert('Missing student ID.');
        return false;
    }

    const generated = SecurePasswordGenerator.generate(12, 1, 1, 1, 1, 0);
	const tempPass = generated.password;	//const tempPass = "password1234";
	const confirmation = confirm(`Reset password for ${studentId} to '${tempPass}'?`);
    if (!confirmation) return false;

    const res = await api('reset_single_password', {
        role: currentUser?.role,
        password: tempPass,
        target_user_id: studentId
    });

    if (res.ok) {
		const copied = await copyToClipboard(tempPass);
        alert((res.message || 'Password reset successful.') + (copied ? '\n\nGenerated password copied to clipboard.' : '\n\nCould not auto-copy. Please copy it manually.'));
	    return true;
    }
	
	alert('Error: ' + (res.error || 'Failed to reset password.'));
    return false;
};

async function checkGlobalStatus() {
    const res = await api('get_today_status');
    const alertBox = document.getElementById('statusAlert');
    const title = document.getElementById('alertTitle');
    const body = document.getElementById('alertBody');

    if (res.ok && (res.isHoliday || res.isSuspended)) {
        alertBox.style.display = 'block';
        
        if (res.isHoliday) {
            // Blue theme for Holidays
            alertBox.className = "card alert-holiday"; // Blue theme for Holidays
            title.innerHTML = `📅 Holiday: ${res.holidayName}`;
            body.innerHTML = "Automatic holiday tagging is active for all classes today.";
        } else if (res.isSuspended || res.isCancelled) {
            // Check if the reason contains a Prof cancellation or Admin suspension
            const isProf = res.suspensionReason.toLowerCase().includes('prof') || 
                           res.suspensionReason.toLowerCase().includes('meeting');           
            const isCancelled = isProf || res.isCancelled;
            alertBox.className = isCancelled ? 'card alert-cancelled' : 'card alert-suspended';
            title.innerHTML = isCancelled ? `📢 Notice of Non-Meeting` : `⚠️ Class Suspension`;
            body.innerHTML = `<strong>Reason:</strong> ${res.suspensionReason}`;
        }
    } else {
        alertBox.style.display = 'none';
    }
}

async function applyOfficerClassStatusUpdate(classCode, studentId, type) {
    const actionText = type === 'CREDITED' ? 'credit' : 'drop';
    const confirmMsg = `Are you sure you want to ${actionText} ${studentId} for ${classCode} for the rest of the semester?`;
    if (!confirm(confirmMsg)) return false;

    const res = await api('credit_attendance', {
        class_code: classCode,
        student_id: studentId,
        type,
        actor_id: currentUser.id
    });

    alert(res.message || (res.ok ? 'Update successful.' : 'Update failed.'));
    if (res.ok) {
        if (typeof loadProfessorDashboard === 'function') await loadProfessorDashboard();
        if (typeof loadTodaySchedule === 'function') await loadTodaySchedule();
        return true;
    }
    return false;
}

window.bulkStatusUpdate = async (studentId, type) => {
    const classCode = selectedMonitorClassCode || getDefaultMonitorClassCode(currentScheduleData);
    if (!classCode) {
        alert('No class selected. Use the officer action panel and pick a class first.');
        return false;
	}
	return applyOfficerClassStatusUpdate(classCode, studentId, type);
};

window.handleStatusChange = async () => {
    const classCode = document.getElementById('suspendClassCode').value;
    const reason = document.getElementById('suspendReason').value.trim();
    const date = document.getElementById('suspendDate').value;
    const type = document.getElementById('statusType').value; // CANCELLED or SUSPENDED

    if (!type) return alert("Please provide a class status.");
    if (!classCode) return alert("Please select a class.");
    if ((!reason || reason.length < 5) && (type == 'CANCELLED' || type == 'SUSPENDED')) return alert("Please provide a detailed reason.");

    let confirmMsg = `Declare ${type.toLowerCase()} for ${classCode}?`;
    if (type == 'CANCELLED' || type == 'SUSPENDED') confirmMsg += `\nReason: ${reason}. This marks the entire roster.`;
    if (!confirm(confirmMsg)) return;

    const res = await api('update_class_status', {
        class_code: classCode, 
        reason: reason, 
        status: type,
        date: date,
        actor_id: currentUser.id
    });

    if (res.ok) {
        alert(`Notice Posted: ${res.message}`);
        document.getElementById('suspendReason').value = '';
         hideModal('classStatusModal');
        // Refresh UI to show the new banner and updated class list immediately
        await checkGlobalStatus();
        if (typeof loadTodaySchedule === 'function') await loadTodaySchedule();
        if (typeof loadProfessorDashboard === 'function') loadProfessorDashboard();
    } else {
        alert(res.error);
    }
};

window.handleMakeUpClass = async () => {
    const code = document.getElementById('makeupClassCode').value;
    const date = document.getElementById('makeupDate').value;
    
    if (!code || !date) return alert("Select both class and date.");

    // Quick Holiday Conflict Check
    const holidayRes = await api('check_holiday', { date: date });
    if (holidayRes.isHoliday) {
        if (!confirm(`Warning: ${date} is marked as ${holidayRes.holidayName}. Are you sure you want a make-up class on a holiday?`)) {
            return;
        }
    }
    
    const res = await api('authorize_makeup', { class_code: code, date: date, actor_id: currentUser.id });
    if (res.ok) {
        alert(res.message);
        hideModal('makeupModal');
        if (typeof loadTodaySchedule === 'function') await loadTodaySchedule();
        if (typeof loadProfessorDashboard === 'function') await loadProfessorDashboard();
        await checkGlobalStatus();
    } else {
        alert(res.error || 'Failed to authorize make-up class.');
    }
};

window.toggleSettings = () => {
    const card = document.getElementById('settingsCard');
    card.style.display = card.style.display === 'none' ? 'block' : 'none';
    document.getElementById('settingsMsg').textContent = '';
};

document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('settingsMsg');
    const current = document.getElementById('currentPw').value.trim();
    const next = document.getElementById('newPw').value.trim();
    const confirmNext = document.getElementById('confirmNewPw').value.trim();

    if (next !== confirmNext) {
        msg.style.color = 'red';
        return msg.textContent = "New passwords do not match.";
    }

    if (next.length < 12) {
        msg.style.color = 'red';
        return msg.textContent = "Password must be at least 12 characters.";
    }

    const res = await api('change_password', {
        user_id: currentUser.id,
        current_password: current,
        new_password: next
    });

    if (res.ok) {
        msg.style.color = 'green';
        msg.textContent = res.message;
        e.target.reset();
        setTimeout(toggleSettings, 2000); // Close settings after success
    } else {
        msg.style.color = 'red';
        msg.textContent = res.error;
    }
});

async function populateClassDropdowns() {
    const suspend = document.getElementById('suspendClassCode');
    const makeup = document.getElementById('makeupClassCode');
    
    const res = await getDropdownData();    
    if (res.ok && res.classes) {
        const options = res.classes.map(c => 
            `<option value="${c.code}">${c.name} [${c.code}]</option>`
        ).join('');
        
        const placeholder = '<option value="">Select Class</option>';
        suspend.innerHTML = placeholder + options;
        makeup.innerHTML = placeholder + options;
    } else {
        suspend.innerHTML = '<option value="">Error loading classes</option>';
        makeup.innerHTML = '<option value="">Error loading classes</option>';
    }
}

/**
 * Generates a password based on positional flags (1 or 0). Customize the character set and the security level.
 * All the computation is done locally on the client side. No data is sent to or received from the server.
 * Based on Project Nayuki: https://www.nayuki.io/page/random-password-generator-javascript
 *
 * Example: 16 characters, Numbers (1), Lower (1), Upper (1), Symbols (1), No Space (0)
 * const result = SecurePasswordGenerator.generate(16, 1, 1, 1, 1, 0);
 * console.log("Password:", result.password);
 * console.log("Strength:", result.entropy, "bits");
 */
class SecurePasswordGenerator {
    static CHARACTER_SETS = [
        ["Numbers", "0123456789"],
        ["Lowercase", "abcdefghijklmnopqrstuvwxyz"],
        ["Uppercase", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
        ["ASCII symbols", "!\"#$%" + String.fromCharCode(38) + "'()*+,-./:;" + String.fromCharCode(60) + "=>?@[\\]^_`{|}~"],	// !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~
        ["Space", "\u00A0"], // Non-breaking space used in original logic
    ];

    /**
     * @param {number} length - Desired length
     * @param {number} n, l, u, s, sp - 1 for True, 0 for False
     */
    static generate(length, n, l, u, s, sp) {
        const flags = [n, l, u, s, sp];
        
        // 1. Build the character pool
        let rawCharset = "";
        this.CHARACTER_SETS.forEach((set, i) => {
            if (flags[i] === 1) rawCharset += set[1];
        });

        // 2. Filter duplicates and handle UTF-16, convert to array of strings
        let charset = [];
        for (const ch of rawCharset) {
            if (!charset.includes(ch)) charset.push(ch);
        }
        if (charset.length === 0) throw new Error("Character set is empty");

        // 3. Generate password using secure random picks
        let password = "";
        for (let i = 0; i < length; i++) {
            password += charset[this.randomInt(charset.length)];
        }

        return {
            password: password,
			statistics: this.getPasswordStats(length, charset)
        };
    }

    /**
     * Combines Math.random and Crypto.getRandomValues for security
     */
    static randomInt(n) {
        const cryptoObj = window.crypto || window.msCrypto;
        if (!cryptoObj || !cryptoObj.getRandomValues) {
            throw new Error('Secure random generator is unavailable in this browser.');
        }

		const cryptoRoll = new Uint32Array(1);
        const maxUInt32 = 2 ** 32;
        const limit = maxUInt32 - (maxUInt32 % n);

        do {
            cryptoObj.getRandomValues(cryptoRoll);
        } while (cryptoRoll[0] >= limit);

        return cryptoRoll[0] % n;
    }
	
	/*
	* Example: 12 chars, Numbers (1), Lower (1), Upper (1), Special (0), Space (0)
	* console.log(getPasswordStats(12, 1, 1, 1, 0, 0));
	* Output: { poolSize: 62, entropyBits: "71.45", strength: "Medium" }
	*/
	static getPasswordStats(length, rawCharset) {
		// Remove duplicates to get true size
		const uniqueChars = [...new Set(rawCharset)];
		const charsetSize = uniqueChars.length;

		// Calculate entropy
		const bits = this.calculateEntropy(charsetSize, length);
		
		// `Length = ${length} chars, ` + `\u00A0\u00A0Charset size = ${charsetSize} symbols, ` + `\u00A0\u00A0Entropy = ${bits} bits` + `\u00A0\u00A0Strength = ${bits < 60 ? "Weak" : bits < 100 ? "Medium" : "Strong"}`;
		return {
			poolSize: charsetSize,
			entropyBits: bits,
			strength: bits < 60 ? "Weak" : bits < 100 ? "Medium" : "Strong"
		};
	}
	
	/**
	 * Calculates the strength of a password in bits.
	 * @param {number} charsetSize - Number of unique characters available.
	 * @param {number} length - The length of the generated password.
	 * @returns {string} - The entropy formatted to 2 decimal places.
	 */
	static calculateEntropy(charsetSize, length) {
		if (charsetSize <= 1 || length <= 0) return "0.00";
		
		// Formula from source: Math.log(charset.length) * length / Math.log(2)
		const entropy = Math.log(charsetSize) * length / Math.log(2);
		
		return entropy.toFixed(2);
	}
}
/*** End SecurePasswordGenerator ***/

// Refresh the dashboard every 60 seconds if the user is an Officer/Prof
setInterval(() => {
    if (currentUser && (currentUser.role === 'professor' || currentUser.role === 'officer' || currentUser.role === 'admin')) {
        hasActiveCheckinWindow().then((isWindowActive) => {
            if (isWindowActive) loadProfessorDashboard();
        });
    }
}, 60000);
