const API_BASE = '/api'; // Optimized for same-domain hosting
let currentUser = null;
let isSignup = false;
let currentScheduleData = [];
let dropdownCache = { data: null, fetchedAt: 0 };
const DROPDOWN_CACHE_TTL_MS = 5 * 60 * 1000;

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
    document.getElementById("hdr").textContent = new Date().toLocaleString("en-US", { dateStyle: 'full' });

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
    const isElevated = currentUser.role === 'officer' || currentUser.role === 'professor';

    controls.style.display = 'block';
    document.getElementById('officerControls').style.display = (currentUser.role === 'officer') ? 'block' : 'none';
    document.getElementById('studentControls').style.display = (currentUser.role === 'student' || currentUser.role === 'officer') ? 'block' : 'none';

    // Fetch Data (Parallelized for speed). We run these at the same time but wait for ALL to finish
    await Promise.all([
        loadTodaySchedule(),  // Hydrates currentScheduleData
        checkGlobalStatus()   // Renders the alert banner
    ]);
    
    // Show both the Live Monitor and Summary to Professors AND Officers
    document.getElementById('profControls').style.display = isElevated ? 'block' : 'none';
    
    // Restricted summary card
    const summaryCard = document.querySelector('#profSummaryOutput').closest('.card');
    if (summaryCard) summaryCard.style.display = isElevated ? 'block' : 'none';

    if (isElevated) {
        loadProfessorDashboard();
        populateClassDropdowns();
    }
}

async function loadProfessorDashboard() {
    const container = document.getElementById('profDashboardOutput');
    const searchWrapper = document.getElementById('searchWrapper');
    const classCode = 'BPAOUMN-1B';
    
    // 1. Check if we have any classes loaded in our global state
    if (!currentScheduleData || currentScheduleData.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding: 20px; background: #f8fafc; border-radius: 8px; border: 1px dashed #cbd5e1;">
                <p style="margin:0;">No active class session for <strong>${classCode}</strong> today.</p>
                <span class="small muted">Live stats will appear once the class starts.</span>
            </div>`;
        if (searchWrapper) searchWrapper.style.display = 'none'; // Hide if no data
        return;
    }
    // 2. Automatically pull the code from the current schedule. Since there are no simultaneous classes, index 0 is the current target
    const activeClass = currentScheduleData?.[0];
    classCode = activeClass?.class_code;

    const res = await api('prof_dashboard', { class_code: classCode });
    if (res.ok) {
        // 3. Logic check: Is this session currently active? 
        // A class is "Active" if it's a regular day OR an authorized makeup
        const hasActiveSession = res.is_makeup_session || res.is_regular_day;
        // IF NO CLASS: Show a simple placeholder message
        if (!hasActiveSession) {
            container.innerHTML = `
                <div style="text-align:center; padding: 20px; background: #f8fafc; border-radius: 8px; border: 1px dashed #cbd5e1;">
                    <p style="margin:0;">No active class session for <strong>${classCode}</strong> today.</p>
                    <span class="small muted">Live stats will appear once the class starts.</span>
                </div>`;
            if (searchWrapper) searchWrapper.style.display = 'none'; // Hide if no session
            return;
        }
        // Show search wrapper now that we have a roster to search through
        if (searchWrapper) searchWrapper.style.display = 'block';

        // 4. Render the Live Dashboard
        renderLiveDashboard(container, res, classCode);
        // Ensure search filter works after re-rendering
        document.getElementById('studentSearch').dispatchEvent(new Event('input'));
    }
}

function renderLiveDashboard(container, res, classCode) {
    // Calculate total students in the roster
    const totalStudents = res.roster.length;

    // Generate HTML for the Stats Cards
    let html = `
        <div style="margin-bottom: 10px; font-weight: bold; color: #1e293b;">
            Monitoring: ${classCode}
        </div>
        <div class="grid">
            ${res.stats.map(s => `
                <div class="card" style="border-left: 4px solid ${s.status === 'PRESENT' ? '#10b981' : '#f59e0b'}; padding: 10px; margin: 0;">
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
        const isMakeup = r.status === 'PENDING' || r.is_makeup_session;

        if (r.status === 'PRESENT') statusColor = "#10b981";
        if (r.status === 'LATE') statusColor = "#f59e0b";
        if (r.status === 'ABSENT' || r.status === 'INCOMPLETE') statusColor = "#ef4444";
        if (r.status === 'EXCUSED') statusColor = "#3b82f6";

        html += `
            <li style="padding: 10px 0; border-bottom: 1px solid #f1f5f9; opacity: ${opacity};">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="flex: 1;">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <strong>${r.user_name}</strong>
                            <span style="font-size:9px; padding:2px 6px; border-radius:10px; background:#f1f5f9; color:${statusColor}; font-weight:bold; border: 1px solid">${r.status}</span>
                        </div>
                        <div class="small muted">${r.time_in ? 'In at ' + r.time_in : 'No time recorded'}</div>
                    </span>
                    <div style="display:flex; gap:4px; align-items:center;">
                        <button onclick="bulkStatusUpdate('${r.user_id}', 'CREDITED')" title="Credit Rest of Semester" style="background:#064e3b; color:white; border:none; padding:4px 8px; font-size:10px; border-radius:4px;">
                            Credit
                        </button>
                        <button onclick="bulkStatusUpdate('${r.user_id}', 'DROPPED')" title="Mark as Dropped" style="background:none; color:#ef4444; border:1px solid #ef4444; padding:4px 8px; font-size:10px; border-radius:4px;">
                            Drop
                        </button>
                        <button onclick="reset_single_password('${r.user_id}')" title="Reset Password" style="background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; padding:4px 8px; font-size:10px; border-radius:4px;">
                            <i class="fa fa-key"></i>
                        </button>
                    </div>
                </div>
            </li>`;
    });

    html += `</ul>`;
    container.innerHTML = html;
}

async function loadTodaySchedule() {
    const list = document.getElementById('scheduleList');
    list.innerHTML = '<div class="small muted">Checking for classes...</div>';
    
    const res = await api('today_schedule', { student_id: currentUser.id });
    
    if (!res.ok) {
        list.innerHTML = '<div class="error-message">Failed to load schedule.</div>';
        return;
    }

    // Check if the list is empty
    if (!res.schedule || res.schedule.length === 0) {
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
    // Otherwise, clear and loop through classes
    list.innerHTML = '';
    const timeMap = {}; // To track time overlaps
    currentScheduleData.forEach(cls => {
        const timeKey = `${cls.start_time}-${cls.end_time}`;
        if (!timeMap[timeKey]) timeMap[timeKey] = [];
        timeMap[timeKey].push(cls.class_code);
        
        const isConflict = timeMap[timeKey].length > 1;
            
        const card = document.createElement('div');
        card.className = 'class-card';
        card.innerHTML = `
            <div style="flex:1">
                <div style="display:flex; align-items:center; gap:8px;">
                    <strong>${cls.class_name} [${cls.class_code}]</strong>
                    ${isConflict ? `<span style="background:#fee2e2; color:#b91c1c; border:1px solid #fecaca; font-size:9px; padding:1px 6px; border-radius:4px; font-weight:bold;">CONFLICT</span>` : ''}
                </div>
                <span class="small muted">${cls.start_time} - ${cls.end_time}</span>
                <div class="small muted" style="margin:5px 0">${cls.professor_name ? '<em>Professor: ' + cls.professor_name + '</em>' : '<em>Professor: TBD</em>'}</div>
                <div id="status-${cls.class_code.replace(/\s+/g, '-')}" class="small" style="margin:5px 0">Checking status...</div>
                
                <div id="excuse-area-${cls.class_code.replace(/\s+/g, '-')}" style="display:none; margin-top:10px; background:#f1f5f9; padding:8px; border-radius:8px;">
                    <input type="text" id="reason-${cls.class_code.replace(/\s+/g, '-')}" placeholder="Reason for excuse..." style="width:97%; font-size:12px; margin-bottom:5px;" minlength="5" required>
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

async function updateCheckinUI(cls) {
    // Sanitize the class code for CSS (e.g., 'POLS 102' becomes 'POLS-102')
    const safeCode = cls.class_code.replace(/\s+/g, '-');
    const btn = document.getElementById(`btn-${safeCode}`);
    const btnContainer = document.getElementById(`btn-${safeCode}`).parentElement;
    const statusSpan = document.getElementById(`status-${safeCode}`);
    const excuseLink = document.getElementById(`excuse-link-${safeCode}`);

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
        // 2. Handle Terminal Statuses (Excused, Holiday, Credited, etc.)
        const specialStatuses = ['EXCUSED', 'SUSPENDED', 'CANCELLED', 'HOLIDAY', 'ABSENT', 'INCOMPLETE', 'ASYNCHRONOUS', 'CREDITED', 'DROPPED'];
        if (specialStatuses.includes(cls.my_status) || (record && specialStatuses.includes(record.status))) {
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
    
        // 3. Handle Self-Service (Credit/Drop)
        const selfServiceContainer = document.getElementById(`self-service-container-${safeCode}`);
        if (!record || record.status === 'not_recorded') {
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
                        type: type 
                    });
                    alert(res.message);
                    loadTodaySchedule();
                }
            };
        }

        // 4. Handle Check-Out Logic
        if (record && record.status !== 'not_recorded' && !record.time_out) {
            if (btn) btn.style.display = 'none';
            renderCheckoutLogic(cls, safeCode, record, config, btnContainer, statusSpan);
            return;    // Exit here so we don't also run the check-in countdown
        }

        // 5. Handle Check-In Countdown
        renderCheckinCountdown(cls, btn, statusSpan, config);
    } catch (err) {
        console.error("UI Update Failed:", err);
        statusSpan.textContent = "Error loading status. Please refresh.";
    }
}

// Helper for Countdown to keep main function clean
function renderCheckinCountdown(cls, btn, statusSpan, config) {
    const safeCode = cls.class_code.replace(/\s+/g, '-');
    const updateInTimer = () => {
        const now = new Date();
        const startParts = parseTimeString(cls.start_time);
        const start = new Date();
        start.setHours(startParts.hours, startParts.minutes, 0, 0);

        const enableFrom = new Date(start.getTime() - config.checkin_window_minutes * 60000);
        const absentThreshold = new Date(start.getTime() + config.absent_window_minutes * 60000);

        if (now >= enableFrom && now <= absentThreshold) {
            // --- WINDOW IS OPEN ---
            btn.disabled = false;
            btn.style.display = 'block';
            statusSpan.textContent = "Check-in window is OPEN";
            statusSpan.style.color = "#10b981";

            // Attach the click handler here
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
                    
                    alert(`Confirmed! You are marked as ${checkRes.status}.\n\n⚠️ IMPORTANT: Remember to Check Out 10 minutes before the class ends, otherwise your record will be marked as INCOMPLETE.`);
                    
                    // Immediately transition the UI to the Check-out state
                    updateCheckinUI(cls); 
                    
                    // Clear the interval timer because we're done with check-in
                    if (window[`timer_${cls.class_code.replace(/\s+/g, '_')}`]) {
                        clearInterval(window[`timer_${cls.class_code.replace(/\s+/g, '_')}`]);
                    }
                } else {
                    alert(checkRes.error);
                    btn.disabled = false;
                    updateInTimer(); // Reset the UI state
                }
            };

        } else if (now > absentThreshold) {
            // --- ABSENT ---
            btn.disabled = true;
            statusSpan.textContent = "Check-in closed (Absent)";
            statusSpan.style.color = "#ef4444";
        } else {
            // --- NOT YET OPEN ---
            const mins = Math.ceil((enableFrom - now) / 60000);
            btn.disabled = true;
            statusSpan.textContent = mins <= config.checkin_window_minutes 
                ? `Opens in ${mins} min(s)` 
                : `Opens at ${cls.start_time}`;
        }
    };

    // Store timer in a dynamic global variable to prevent memory leaks or overlaps
    const intervalKey = `timer_${safeCode}`;    // Use a unique ID for the interval so classes don't fight over the same timer
    if (window[intervalKey]) clearInterval(window[intervalKey]);
    updateInTimer();     // Execute IMMEDIATELY
    window[intervalKey] = setInterval(updateInTimer, 30000);    // Then set the interval
}

function renderCheckoutLogic(cls, safeCode, record, config, btnContainer, statusSpan) {
    // 1. Prevent button duplication
    if (document.querySelector(`.checkout-btn-${safeCode}`)) return;

    const outBtn = document.createElement('button');
    // Only students marked PRESENT or LATE need to check out
    if (record.status === 'PRESENT' || record.status === 'LATE') {
        outBtn.className = `checkout-btn checkout-btn-${safeCode}`;
        outBtn.textContent = "Check Out";
        outBtn.style.display = 'block';
        outBtn.disabled = true;
        btnContainer.appendChild(outBtn);

        const updateOutTimer = () => {
            const now = new Date();
            const endParts = parseTimeString(cls.end_time);
            const end = new Date();
            end.setHours(endParts.hours, endParts.minutes, 0, 0);

            // Window opens X minutes before class ends (from config)
            const enableFrom = new Date(end.getTime() - (config.checkout_window_minutes * 60000));

            if (now >= enableFrom) {
                outBtn.disabled = false;
                statusSpan.textContent = "Check-out is now OPEN";
                statusSpan.style.color = "#f59e0b"; // Orange/Amber
            } else {
                const minsToOut = Math.ceil((enableFrom - now) / 60000);
                statusSpan.textContent = `Check-out available in ${minsToOut} mins`;
                statusSpan.style.color = "#64748b";
            }
        };

        outBtn.onclick = async () => {
            if (!confirm("Are you sure you want to check out now?")) return;
            
            outBtn.disabled = true;
            const res = await api('checkout', { 
                class_code: cls.class_code, 
                student_id: currentUser.id 
            });

            if (res.ok) {
                outBtn.remove();
                // Remove the reminder if it exists
                const reminder = document.querySelector(`.reminder-${safeCode}`);
                if (reminder) reminder.remove();
                
                statusSpan.innerHTML = `<span style="color: #10b981;"><i class="fa fa-check-circle"></i> Completed (Out: ${res.time_out})</span>`;
            } else {
                alert(res.error);
                outBtn.disabled = false;
            }
        };

        // Add a visual reminder so they don't close the app and forget
        const reminder = document.createElement('div');
        reminder.className = `small reminder-${safeCode}`;
        reminder.style.cssText = "color: #e11d48; margin-top: 10px; font-weight: bold; animation: subtle-shake 2s infinite;";
        reminder.innerHTML = `<i class="fa fa-exclamation-circle"></i> Stay on this page! Check out at ${cls.end_time}.`;
        btnContainer.appendChild(reminder);

        setInterval(updateOutTimer, 30000);
        updateOutTimer();
    }
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

async function loadAttendanceSummary() {
    const container = document.getElementById('profSummaryOutput');
    container.innerHTML = '<div class="small muted"><i class="fa fa-spinner fa-spin"></i> Calculating totals...</div>';
    const classCode = "BPAOUMN-1B"; // Dynamic if needed
    
    const res = await api('prof_summary', { class_code: classCode });
    if (res.ok) {
        let tableHtml = `
            <table style="width:100%; border-collapse: collapse; font-size: 12px; margin-top: 15px;">
                <thead>
                    <tr style="background: #f1f5f9; text-align: left;">
                        <th style="padding: 8px; border: 1px solid #e2e8f0;">Student Name</th>
                        <th style="padding: 8px; border: 1px solid #e2e8f0; color: #10b981;">P</th>
                        <th style="padding: 8px; border: 1px solid #e2e8f0; color: #f59e0b;">L</th>
                        <th style="padding: 8px; border: 1px solid #e2e8f0; color: #ef4444;">A</th>
                        <th style="padding: 8px; border: 1px solid #e2e8f0; color: #64748b;">INC</th>
                    </tr>
                </thead>
                <tbody>
        `;

        res.summary.forEach(row => {
            tableHtml += `
                <tr>
                    <td style="padding: 8px; border: 1px solid #e2e8f0;"><strong>${row.user_name}</strong></td>
                    <td style="padding: 8px; border: 1px solid #e2e8f0;">${row.present_count}</td>
                    <td style="padding: 8px; border: 1px solid #e2e8f0;">${row.late_count}</td>
                    <td style="padding: 8px; border: 1px solid #e2e8f0;">${row.absent_count}</td>
                    <td style="padding: 8px; border: 1px solid #e2e8f0; font-weight: ${row.incomplete_count > 0 ? 'bold' : 'normal'}">${row.incomplete_count}</td>
                </tr>
            `;
        });

        tableHtml += `</tbody></table>`;
        container.innerHTML = tableHtml;
    }
}

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

window.bulkStatusUpdate = async (studentId, type) => {
    const classCode = "BPAOUMN-1B"; // Get current active class
    const confirmMsg = `Are you sure you want to mark this student as ${type} for the rest of the semester?`;
    
    if (confirm(confirmMsg)) {
        const res = await api('credit_attendance', { 
            class_code: classCode, 
            student_id: studentId,
            type: type 
        });
        alert(res.message);
        loadProfessorDashboard();
    }
};

window.handleStatusChange = async () => {
    const classCode = document.getElementById('suspendClassCode').value;
    const reason = document.getElementById('suspendReason').value.trim();
    const type = document.getElementById('statusType').value; // CANCELLED or SUSPENDED
    
    if ((!reason || reason.length < 5) && (type == 'CANCELLED' || type == 'SUSPENDED')) return alert("Please provide a detailed reason.");

    const confirmMsg = `Declare ${type.toLowerCase()} for ${classCode}?\nReason: ${reason}. This marks the entire roster.`;
    if (type == 'CANCELLED' || type == 'SUSPENDED') confirmMsg += `\nReason: ${reason}. This marks the entire roster.`;
    if (!confirm(confirmMsg)) return;

    const res = await api('update_class_status', {
        class_code: classCode, 
        reason: reason, 
        status: type 
    });

    if (res.ok) {
        alert(`Notice Posted: ${res.message}`);
        document.getElementById('suspendReason').value = '';
        // Refresh UI to show the new banner immediately
        checkGlobalStatus();
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
    
    const res = await api('authorize_makeup', { class_code: code, date: date });
    if (res.ok) {
        alert(res.message);
        loadTodaySchedule(); 
    }
};

window.toggleSettings = () => {
    const card = document.getElementById('settingsCard');
    card.style.display = card.style.display === 'none' ? 'block' : 'none';
    document.getElementById('settingsMsg').textContent = '';
};

window.toggleProfSummary = () => {
    const summaryDiv = document.getElementById('profSummaryOutput');
    const btn = document.getElementById('toggleTotalsBtn');
    
    if (!summaryDiv || !btn) return;

    if (summaryDiv.style.display === 'none') {
        // Show it
        summaryDiv.style.display = 'block';
        btn.textContent = 'Hide Totals';
        btn.style.background = '#64748b'; // Change color to indicate "active" state
        
        // Optional: Trigger the data load only when opened to save resources
        if (summaryDiv.innerHTML.trim() === "") {
            loadAttendanceSummary(); 
        }
    } else {
        // Hide it
        summaryDiv.style.display = 'none';
        btn.textContent = 'View Totals';
        btn.style.background = ''; // Revert to original CSS
    }
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

// Refresh the dashboard every 60 seconds if the user is an Officer/Prof
setInterval(() => {
    if (currentUser && (currentUser.role === 'professor' || currentUser.role === 'officer')) {
        loadProfessorDashboard();
    }
}, 60000);
