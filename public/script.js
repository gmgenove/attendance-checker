const API_BASE = '/api'; // Optimized for same-domain Render hosting
let currentUser = null;
let isSignup = false;
let timer = null;

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
    document.getElementById('togglePassword').addEventListener('click', function() {
        const pwd = document.getElementById('passwordInput');
        pwd.type = pwd.type === 'password' ? 'text' : 'password';
        this.classList.toggle('fa-eye-slash');
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

        const authMsg = document.getElementById('authMsg');
        if (authMsg) authMsg.textContent = isSignup ? "Signing up..." : "Signing in...";
        
        try {
            const data = await api(isSignup ? "signup" : "signin", {
                id: idInput.value.trim(),
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
        
        listItems.forEach(item => {
            const name = item.textContent.toLowerCase();
            // Hide items that don't match the search term
            item.style.display = name.includes(term) ? 'block' : 'none';
        });
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

function showApp() {
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
    document.getElementById('studentControls').style.display = (currentUser.role === 'student') ? 'block' : 'none';

    loadTodaySchedule();
    checkGlobalStatus();
    
    // Show both the Live Monitor and Summary to Professors AND Officers
    document.getElementById('profControls').style.display = isElevated ? 'block' : 'none';
    
    // Restricted summary card
    const summaryCard = document.querySelector('#profSummaryOutput').closest('.card');
    if (summaryCard) summaryCard.style.display = isElevated ? 'block' : 'none';

    if (isElevated) {
        loadProfessorDashboard();
    }
}

async function loadProfessorDashboard() {
    const container = document.getElementById('profDashboardOutput');
    const classCode = "BPAOUMN-1B"; 
    
    const res = await api('prof_dashboard', { class_code: classCode });
    if (res.ok) {
        let html = `
            <div class="grid">
                ${res.stats.map(s => `
                    <div class="card" style="border-left: 4px solid ${s.status === 'PRESENT' ? '#10b981' : '#f59e0b'}; padding: 10px;">
                        <div class="small muted">${s.status}</div>
                        <strong>${s.count}</strong>
                    </div>
                `).join('')}
            </div>
            <h5 style="margin-top:15px;">Live Roster</h5>
            <ul id="recentCheckinList" class="small" style="list-style: none; padding: 0;">
        `;

        res.roster.forEach(r => {
            let statusColor = "#94a3b8"; // Default Grey for NOT YET ARRIVED
            let opacity = "1";

            if (r.status === 'PRESENT') statusColor = "#10b981";
            if (r.status === 'LATE') statusColor = "#f59e0b";
            if (r.status === 'ABSENT' || r.status === 'INCOMPLETE') statusColor = "#ef4444"; // Red for issues
            if (r.status === 'NOT YET ARRIVED') opacity = "0.6";

            html += `
                <li style="padding: 10px 0; border-bottom: 1px solid #f1f5f9; opacity: ${opacity};">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span>
                            <strong>${r.user_name}</strong>
                            <div class="small muted">${r.time_in ? 'In at ' + r.time_in : 'No time recorded'}</div>
                        </span>
                        <span style="font-weight:bold; font-size:10px; color:${statusColor}">${r.status}</span>
                    </div>
                </li>
                <li style="padding: 10px 0; border-bottom: 1px solid #f1f5f9;">
                    <span><strong>${r.user_name}</strong></span>
                    <button onclick="resetSinglePassword('${r.user_id}')" class="small" style="float:right; background:none; border:1px solid #ddd;">Reset PW</button>
                </li>
                <li style="padding: 10px 0; border-bottom: 1px solid #f1f5f9;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span><strong>${r.user_name}</strong></span>
                        <div style="margin-top:5px;">
                            <button onclick="bulkStatusUpdate('${r.user_id}', 'CREDITED')" class="small">Credit All</button>
                            <button onclick="bulkStatusUpdate('${r.user_id}', 'DROPPED')" class="small danger">Mark Dropped</button>
                        </div>
                </li>`;
        });
        
        html += `</ul>`;
        container.innerHTML = html;
        
        // Ensure search filter still works on the new list
        document.getElementById('studentSearch').dispatchEvent(new Event('input'));
    }
}

async function loadTodaySchedule() {
    const list = document.getElementById('scheduleList');
    list.innerHTML = '<div class="small muted">Checking for classes...</div>';
    
    const res = await api('today_schedule');
    
    if (!res.ok) {
        list.innerHTML = '<div class="error-message">Failed to load schedule.</div>';
        return;
    }

    // Check if the list is empty
    if (!res.schedule || res.schedule.length === 0) {
        list.innerHTML = `
            <div class="card" style="text-align:center; padding: 40px 20px; border: 1px dashed #cbd5e1; background: #f8fafc;">
                <i class="fa fa-calendar-o" style="font-size: 2rem; color: #94a3b8; margin-bottom: 10px;"></i>
                <div class="small muted">There are no classes scheduled for today.</div>
                <div class="small" style="margin-top:5px; color: #64748b;">Enjoy your break!</div>
            </div>
        `;
        return;
    }

    // Otherwise, clear and loop through classes
    list.innerHTML = '';
    res.schedule.forEach(cls => {
        const card = document.createElement('div');
        card.className = 'class-card';
        card.innerHTML = `
            <div style="flex:1">
                <strong>${cls.class_name}</strong><br>
                <span class="small muted">${cls.start_time} - ${cls.end_time}</span>
                <div class="small muted" style="margin:5px 0">Prof. ${cls.professor_name}</div>
                <div id="status-${cls.class_code.replace(/\s+/g, '-')}" class="small" style="margin:5px 0">Checking status...</div>
                
                <div id="excuse-area-${cls.class_code.replace(/\s+/g, '-')}" style="display:none; margin-top:10px; background:#f1f5f9; padding:8px; border-radius:8px;">
                    <input type="text" id="reason-${cls.class_code.replace(/\s+/g, '-')}" placeholder="Reason for excuse..." style="width:100%; font-size:12px; margin-bottom:5px;">
                    <button onclick="submitExcuse('${cls.class_code.replace(/\s+/g, '-')}')" style="font-size:11px; padding:5px 10px; background:#64748b; color:white; border:none;">Submit Excuse</button>
                </div>
            </div>
            <div class="class-actions" style="text-align:right">
                <button class="checkin-btn" id="btn-${cls.class_code.replace(/\s+/g, '-')}" disabled>Check In</button>
                <div style="margin-top:8px">
                    <a href="#" onclick="toggleExcuse(event, '${cls.class_code.replace(/\s+/g, '-')}')" class="small muted" style="text-decoration:none">File Excuse?</a>
                </div>
            </div>
        `;
        list.appendChild(card);
        updateCheckinUI(cls);
    });
}

async function updateCheckinUI(cls) {
    const btn = document.getElementById(`btn-${cls.class_code.replace(/\s+/g, '-')}`);
    const btnContainer = document.getElementById(`btn-${cls.class_code.replace(/\s+/g, '-')}`).parentElement;
    const statusSpan = document.getElementById(`status-${cls.class_code.replace(/\s+/g, '-')}`);

    const configData = await api('getConfig');
    const config = configData.config;
    
    // 1. Initial status check from server
    const res = await api('get_attendance', { class_code: cls.class_code, student_id: currentUser.id });
    const record = res.record;
    
    if (record && record.attendance_status && record.attendance_status !== 'not_recorded') {
        statusSpan.textContent = `Status: ${record.attendance_status}`;
        btn.style.display = 'none';
        // Even if already checked in, check if we need to show the Check-out button logic
    }
    
    // --- RENDER CHECK-OUT BUTTON ---
    if (record && record.status !== 'not_recorded' && !record.time_out) {
        // Sanitize the class code for CSS (e.g., 'POLS 102' becomes 'POLS-102')
        const safeCode = cls.class_code.replace(/\s+/g, '-');
        
        // Check if button already exists using the sanitized class
        if (document.querySelector(`.checkout-btn-${safeCode}`)) return; 
    
        const outBtn = document.createElement('button');
        // Add the sanitized class to the button
        outBtn.className = `checkout-btn checkout-btn-${safeCode}`;
        outBtn.textContent = "Check Out";
        outBtn.disabled = true;
        btnContainer.appendChild(outBtn);

        const updateOutTimer = () => {
            const tzNow = new Date();
            const [hh, mm] = cls.end_time.split(':');
            const end = new Date();
            const endParts = parseTimeString(cls.end_time);
            end.setHours(endParts.hours, endParts.minutes, 0, 00);

            const enableFrom = new Date(end.getTime() - config.checkout_window_minutes * 60000); // 10 mins before end

            if (tzNow >= enableFrom) {
                outBtn.disabled = false;
                statusSpan.textContent = "Check-out is now OPEN";
            } else {
                const minsToOut = Math.ceil((enableFrom - tzNow) / 60000);
                statusSpan.textContent = `Check-out available in ${minsToOut} mins`;
            }
        };

        outBtn.onclick = async () => {
            outBtn.disabled = true;
            const outRes = await api('checkout', { class_code: cls.class_code, student_id: currentUser.id });
            if (outRes.ok) {
                outBtn.remove();
                statusSpan.textContent = `Completed (Out: ${outRes.time_out})`;
            }
        };

        if (record && !record.time_out) {
            const reminder = document.createElement('div');
            reminder.className = 'small';
            reminder.style.color = '#e11d48'; // A subtle alert red
            reminder.style.marginTop = '10px';
            reminder.innerHTML = `<i class="fa fa-exclamation-circle"></i> Don't forget to check out at ${cls.end_time}!`;
            btnContainer.appendChild(reminder);
        }

        setInterval(updateOutTimer, 30000);
        updateOutTimer();
    }

    // 2. Countdown Logic for "Not Yet Open" classes
    const updateCountdown = () => {
        const tzNow = new Date();
        const startParts = parseTimeString(cls.start_time);    // convert am/pm to 24hr
        const start = new Date();
        start.setHours(startParts.hours, startParts.minutes, 0, 0);

        // Your check-in window (matches server: 10 mins before)
        const enableFrom = new Date(start.getTime() - config.checkin_window_minutes * 60000);
        const absentThreshold = new Date(start.getTime() + config.absent_window_minutes * 60000);

        if (tzNow >= enableFrom && tzNow <= absentThreshold) {
            // Window is open!
            btn.disabled = false;
            statusSpan.textContent = "Check-in window is OPEN";
            statusSpan.style.color = "#10b981";
            if (timer) clearInterval(timer); // Stop counting down once open
        } else if (now > absentThreshold) {
            btn.disabled = true;
            statusSpan.textContent = "Check-in closed (Absent)";
            statusSpan.style.color = "#ef4444";
        } else {
            const minsRemaining = Math.ceil((enableFrom - tzNow) / 60000);
            btn.disabled = true;
            if (minsRemaining <= config.checkin_window_minutes) statusSpan.style.color = "#f59e0b";
            statusSpan.textContent = diff <= config.checkin_window_minutes 
                ? `Check-in opens in ${diff} min(s)`        // Approaching opening time
                : `Check-in opens at ${cls.start_time}`;    // Far in the future
        }
    };

    // Run immediately and then every 30 seconds
    const timer = setInterval(updateCountdown, 30000);
    updateCountdown();

    // 3. Handle the Click
    btn.onclick = async () => {
        btn.disabled = true;
        statusSpan.textContent = 'Verifying...';
        
        const checkRes = await api('checkin', { class_code: cls.class_code, student_id: currentUser.id });
        
        if (checkRes.ok) {
            statusSpan.textContent = `Status: ${checkRes.status}`;
            statusSpan.style.color = "#10b981";
            btn.style.display = 'none';
            
            // --- NEW REMINDER POPUP ---
            alert(`Success! You are marked as ${checkRes.status}.\n\n⚠️ IMPORTANT: Remember to Check Out 10 minutes before the class ends, otherwise your record will be marked as INCOMPLETE.`);
            
            // Immediately reload the UI to show the Check-out button (if applicable)
            updateCheckinUI(cls); 
            
            if (typeof timer !== 'undefined') clearInterval(timer);
        } else {
            alert(checkRes.error);
            btn.disabled = false;
            updateCountdown();
        }
    };

    // Use the dynamic adjustment end from the database
    const adjustmentEnd = new Date(config.adjustment_end);
    const now = new Date();

    if (new Date() <= adjustmentEnd && (!record || record.attendance_status === 'not_recorded')) {
        const creditBtn = document.createElement('button');
        creditBtn.textContent = "Claim Attendance Credit";
        creditBtn.className = "small muted";
        creditBtn.onclick = () => api('credit_attendance', { class_code: cls.class_code, student_id: currentUser.id });
        btnContainer.appendChild(creditBtn);

        creditBtn.onclick = async () => {
            if (confirm("This will mark you as CREDITED for ALL remaining sessions of this class for the entire semester. Proceed?")) {
                const res = await api('credit_attendance', { 
                    class_code: cls.class_code, 
                    student_id: currentUser.id 
                });
                alert(res.message);
                loadTodaySchedule();
            }
        };
    }
}

// Optimized Report Handler
document.getElementById('reportType').onchange = async (e) => {
    const container = document.getElementById('reportParams');
    const type = e.target.value;
    if (!type) return container.innerHTML = '';
    
    container.innerHTML = 'Loading options...';
    const data = await api('get_dropdowns');
    
    if (type === 'class') {
        container.innerHTML = `<select id="paramId"><option value="">Select Class</option>${data.classes.map(c => `<option value="${c.code}">${c.name}</option>`).join('')}</select>`;
    } else {
        container.innerHTML = `<select id="paramId"><option value="">Select Student</option>${data.students.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select>`;
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
        const res = await api('bulk_password_reset');
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
            alertBox.style.background = '#dbeafe';
            alertBox.style.color = '#1e40af';
            alertBox.style.border = '1px solid #bfdbfe';
            title.innerHTML = `📅 Holiday: ${res.holidayName}`;
            body.innerHTML = "Automatic holiday tagging is active for all classes today.";
        } else if (res.isSuspended) {
            // Purple theme for Suspensions
            alertBox.style.background = '#f3e8ff';
            alertBox.style.color = '#6b21a8';
            alertBox.style.border = '1px solid #e9d5ff';
            title.innerHTML = `⚠️ Class Suspension`;
            body.innerHTML = `Reason: ${res.suspensionReason}`;
        }
    } else {
        alertBox.style.display = 'none';
    }
}

// Toggle the excuse input visibility
window.toggleExcuse = (e, classCode) => {
    e.preventDefault();
    const area = document.getElementById(`excuse-area-${classCode}`);
    area.style.display = area.style.display === 'none' ? 'block' : 'none';
};

// Send the excuse to the server
window.submitExcuse = async (classCode) => {
    const reasonInput = document.getElementById(`reason-${classCode}`);
    const reason = reasonInput.value;
    
    const res = await api('submit_excuse', { 
        class_code: classCode, 
        student_id: currentUser.id, 
        reason: reason 
    });

    if (res.ok) {
        alert("Excuse filed! This will be included in the official Excuse Log.");
        loadTodaySchedule(); 
    } else {
        alert(res.error);
    }
};

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

window.handleSuspension = async () => {
    const classCode = document.getElementById('suspendClassCode').value;
    const reason = document.getElementById('suspendReason').value;
    
    if (!confirm(`Declare suspension for ${classCode}? This marks the entire roster.`)) return;

    const res = await api('suspend_class', { class_code: classCode, reason: reason });
    if (res.ok) {
        alert(res.message);
        document.getElementById('suspendReason').value = '';
        if (typeof loadProfessorDashboard === 'function') loadProfessorDashboard();
    } else {
        alert(res.error);
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
    const current = document.getElementById('currentPw').value;
    const next = document.getElementById('newPw').value;
    const confirmNext = document.getElementById('confirmNewPw').value;

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

window.onload = () => {
    const saved = localStorage.getItem('currentUser');
    if (saved) {
        currentUser = JSON.parse(saved);
        showApp();
    }
};

// Refresh the dashboard every 60 seconds if the user is an Officer/Prof
setInterval(() => {
    if (currentUser && (currentUser.role === 'professor' || currentUser.role === 'officer')) {
        loadProfessorDashboard();
    }
}, 60000);
