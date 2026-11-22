






























































































































































































































































































































































































































































































































































































































































"use strict";



/* ============================================================

   RISHI MUSIC — HIGH-CAPACITY ENGINE

   - On-demand audio streaming

   - Background playback

   - Daily song rotation

   - Virtual pagination for 800+ tracks

   - Custom settings and themes

   ============================================================ */



/* 1. SERVICE WORKER */

if ("serviceWorker" in navigator) {

    window.addEventListener("load", function () {

        navigator.serviceWorker.register("./sw.js").catch(function (err) {

            console.error("[Rishi Music] SW Registration Failed:", err);

        });

    });

}



/* 2. INDEXEDDB — EXISTING MUSIC DATABASE */



const DB_NAME = "RishiMusicDB_v4";

const DB_VERSION = 1;

const STORE_NAME = "audio_library";



let db = null;



function initDB() {

    return new Promise(function (resolve, reject) {

        const request = indexedDB.open(DB_NAME, DB_VERSION);



        request.onupgradeneeded = function (e) {

            const database = e.target.result;



            if (!database.objectStoreNames.contains(STORE_NAME)) {

                database.createObjectStore(STORE_NAME, {

                    keyPath: "id"

                });

            }

        };



        request.onsuccess = function () {

            db = request.result;

            resolve(db);

        };



        request.onerror = function () {

            reject(request.error);

        };

    });

}



function getAllTracksMetadata() {

    return new Promise(function (resolve) {

        if (!db) return resolve([]);



        const tx = db.transaction([STORE_NAME], "readonly");

        const store = tx.objectStore(STORE_NAME);

        const metadata = [];

        const req = store.openCursor();



        req.onsuccess = function (e) {

            const cursor = e.target.result;



            if (cursor) {

                metadata.push({

                    id: cursor.value.id,

                    title: cursor.value.title,

                    director: cursor.value.director

                });



                cursor.continue();

            } else {

                resolve(metadata);

            }

        };



        req.onerror = function () {

            resolve([]);

        };

    });

}



function getTrackAudioBlob(id) {

    return new Promise(function (resolve, reject) {

        if (!db) return reject(new Error("DB closed"));



        const tx = db.transaction([STORE_NAME], "readonly");

        const store = tx.objectStore(STORE_NAME);

        const req = store.get(id);



        req.onsuccess = function () {

            resolve(req.result ? req.result.blob : null);

        };



        req.onerror = function () {

            reject(req.error);

        };

    });

}



function saveTracksBatch(trackList) {

    return new Promise(function (resolve, reject) {

        if (!db || !trackList.length) return resolve();



        const tx = db.transaction([STORE_NAME], "readwrite");

        const store = tx.objectStore(STORE_NAME);



        for (let i = 0; i < trackList.length; i++) {

            store.put(trackList[i]);

        }



        tx.oncomplete = function () {

            resolve();

        };



        tx.onerror = function (e) {

            reject(e);

        };

    });

}



function removeTrackFromDB(id) {

    return new Promise(function (resolve) {

        if (!db) return resolve();



        const tx = db.transaction([STORE_NAME], "readwrite");

        const store = tx.objectStore(STORE_NAME);



        store.delete(id);



        tx.oncomplete = function () {

            resolve();

        };

    });

}



/* 3. APPLICATION STATE */



let tracks = [];

let currentTrackIndex = -1;

let currentBlobUrl = null;

let playHistory = [];

let userManuallyPaused = false;

let isSwitchingSong = false;

let activeEditingTrackId = null;

let deferredPrompt = null;

let pendingImportFiles = [];



const BATCH_SIZE = 40;



let renderedCount = 0;

let filteredTrackIndices = [];



/* 4. DOM REFERENCES */



const audio = document.getElementById("audioEl");

const tracksContainer = document.getElementById("tracksContainer");

const searchInput = document.getElementById("searchInput");

const directorFilter = document.getElementById("directorFilter");

const importBtn = document.getElementById("importBtn");

const fileSelector = document.getElementById("fileSelector");



const mainPlayBtn = document.getElementById("mainPlayBtn");

const mainPlayIcon = document.getElementById("mainPlayIcon");



const prevBtn = document.getElementById("prevBtn");

const nextBtn = document.getElementById("nextBtn");



const progressBar = document.getElementById("progressBar");

const currentTimeEl = document.getElementById("currentTime");

const durationEl = document.getElementById("duration");



const dockTitle = document.getElementById("dockTitle");

const dockSubtitle = document.getElementById("dockSubtitle");



const installBar = document.getElementById("installBar");

const installTriggerBtn = document.getElementById("installTriggerBtn");



/* Edit modal */



const editModal = document.getElementById("editModal");

const editTitleInput = document.getElementById("editTitleInput");

const editDirectorInput = document.getElementById("editDirectorInput");

const cancelEditBtn = document.getElementById("cancelEditBtn");

const saveEditBtn = document.getElementById("saveEditBtn");



/* Bulk import modal */



const bulkDirectorModal = document.getElementById("bulkDirectorModal");

const bulkDirectorInput = document.getElementById("bulkDirectorInput");

const skipBulkDirectorBtn = document.getElementById("skipBulkDirectorBtn");

const saveBulkDirectorBtn = document.getElementById("saveBulkDirectorBtn");



/* 5. DAILY ROTATION ENGINE */



function getTodayDateString() {

    const d = new Date();



    return d.getFullYear() + "-" +

        String(d.getMonth() + 1).padStart(2, "0") + "-" +

        String(d.getDate()).padStart(2, "0");

}



function getDailyLog() {

    const today = getTodayDateString();



    try {

        const raw = localStorage.getItem("rishi_daily_plays_v4");

        let parsed = raw ? JSON.parse(raw) : null;



        if (!parsed ||

            parsed.date !== today ||

            !Array.isArray(parsed.playedIds)) {



            parsed = {

                date: today,

                playedIds: []

            };



            localStorage.setItem(

                "rishi_daily_plays_v4",

                JSON.stringify(parsed)

            );

        }



        return parsed;



    } catch (e) {

        return {

            date: today,

            playedIds: []

        };

    }

}



function saveDailyLog(log) {

    try {

        localStorage.setItem(

            "rishi_daily_plays_v4",

            JSON.stringify(log)

        );

    } catch (e) {

        console.warn("Storage error:", e);

    }

}



function markSongAsPlayed(songId) {

    const log = getDailyLog();



    if (!log.playedIds.includes(songId)) {

        log.playedIds.push(songId);

    }



    saveDailyLog(log);

    renderTrackList(false);

}



function getNextUnplayedIndex() {

    if (tracks.length === 0) return -1;



    const selectedDirector = directorFilter

        ? directorFilter.value

        : "ALL";



    const log = getDailyLog();

    const playedSet = new Set(log.playedIds);



    let poolIndices = [];



    for (let i = 0; i < tracks.length; i++) {

        const matchesDirector =

            selectedDirector === "ALL" ||

            tracks[i].director === selectedDirector;



        if (matchesDirector) {

            poolIndices.push(i);

        }

    }



    if (poolIndices.length === 0) return -1;



    const unplayed = poolIndices.filter(function (idx) {

        return !playedSet.has(tracks[idx].id) &&

            idx !== currentTrackIndex;

    });



    if (unplayed.length === 0) {

        return -1;

    }



    const rand = Math.floor(Math.random() * unplayed.length);



    return unplayed[rand];

}



/* 6. MEDIA SESSION */



function updateMediaSession(track) {

    if (!("mediaSession" in navigator) || !track) return;



    try {

        navigator.mediaSession.metadata = new MediaMetadata({

            title: track.title,

            artist: track.director,

            album: "Rishi Music"

        });



        navigator.mediaSession.setActionHandler("play", function () {

            userManuallyPaused = false;

            playCurrentTrack();

        });



        navigator.mediaSession.setActionHandler("pause", function () {

            pauseCurrentTrack();

        });



        navigator.mediaSession.setActionHandler("nexttrack", function () {

            userManuallyPaused = false;

            advanceToNextTrack();

        });



        navigator.mediaSession.setActionHandler("previoustrack", function () {

            userManuallyPaused = false;

            playPreviousTrack();

        });



        navigator.mediaSession.setActionHandler("seekto", function (e) {

            if (e.seekTime && Number.isFinite(e.seekTime)) {

                audio.currentTime = e.seekTime;

            }

        });



    } catch (e) {

        console.warn("MediaSession error:", e);

    }

}



/* 7. PLAYBACK PIPELINE */



async function loadTrackSource(index) {

    if (index < 0 || index >= tracks.length) return false;



    currentTrackIndex = index;



    const track = tracks[currentTrackIndex];



    if (currentBlobUrl) {

        URL.revokeObjectURL(currentBlobUrl);

        currentBlobUrl = null;

    }



    const blob = await getTrackAudioBlob(track.id);



    if (!blob) {

        console.error("Audio data missing for track:", track);

        return false;

    }



    currentBlobUrl = URL.createObjectURL(blob);



    audio.pause();

    audio.src = currentBlobUrl;



    dockTitle.textContent = track.title;

    dockSubtitle.textContent = track.director;



    currentTimeEl.textContent = "0:00";

    durationEl.textContent = "0:00";



    progressBar.value = 0;



    updateMediaSession(track);

    renderTrackList(false);



    return true;

}



async function playCurrentTrack() {

    if (currentTrackIndex === -1 && tracks.length > 0) {

        const firstIdx = getNextUnplayedIndex();



        if (firstIdx === -1) {

            alert(

                "All songs in this selection have been played today! Tap any song voluntarily to replay."

            );

            return;

        }



        await loadTrackSource(firstIdx);

    }



    const track = tracks[currentTrackIndex];



    if (!track) return;



    userManuallyPaused = false;



    try {

        await audio.play();



        setPlayIconState(true);



        if ("mediaSession" in navigator) {

            navigator.mediaSession.playbackState = "playing";

        }



        renderTrackList(false);



    } catch (error) {

        console.warn("Playback prevented or deferred:", error);

        setPlayIconState(false);

    }

}



function pauseCurrentTrack() {

    userManuallyPaused = true;



    audio.pause();



    setPlayIconState(false);



    if ("mediaSession" in navigator) {

        navigator.mediaSession.playbackState = "paused";

    }



    renderTrackList(false);

}



async function advanceToNextTrack() {

    if (isSwitchingSong || tracks.length === 0) return;



    isSwitchingSong = true;

    userManuallyPaused = false;



    if (currentTrackIndex !== -1) {

        playHistory.push(currentTrackIndex);



        if (playHistory.length > 50) {

            playHistory.shift();

        }

    }



    const nextIndex = getNextUnplayedIndex();



    if (nextIndex === -1) {

        pauseCurrentTrack();



        dockTitle.textContent = "Finished for today";



        dockSubtitle.textContent =

            "All songs played. Tap any song voluntarily to replay.";



        isSwitchingSong = false;

        return;

    }



    const loaded = await loadTrackSource(nextIndex);



    if (loaded) {

        await playCurrentTrack();

    }



    isSwitchingSong = false;

}



async function playPreviousTrack() {

    if (tracks.length === 0) return;



    userManuallyPaused = false;



    if (audio.currentTime > 3) {

        audio.currentTime = 0;

        await playCurrentTrack();

        return;

    }



    if (playHistory.length > 0) {

        const prevIdx = playHistory.pop();



        await loadTrackSource(prevIdx);

        await playCurrentTrack();



    } else {

        audio.currentTime = 0;

        await playCurrentTrack();

    }

}



/* 8. AUDIO EVENT LISTENERS */



audio.addEventListener("ended", function () {

    if (userManuallyPaused || isSwitchingSong) return;



    const currentTrack = tracks[currentTrackIndex];



    if (currentTrack) {

        markSongAsPlayed(currentTrack.id);

    }



    advanceToNextTrack();

});



audio.addEventListener("error", function () {

    if (userManuallyPaused || isSwitchingSong) return;



    advanceToNextTrack();

});



audio.addEventListener("pause", function () {

    if (!userManuallyPaused && !audio.ended && !isSwitchingSong) {

        setTimeout(function () {

            if (!userManuallyPaused && audio.paused) {

                audio.play().catch(() => {});

            }

        }, 400);

    }

});



audio.addEventListener("timeupdate", function () {

    if (!audio.duration) return;



    progressBar.value =

        (audio.currentTime / audio.duration) * 100;



    currentTimeEl.textContent = formatTime(audio.currentTime);

    durationEl.textContent = formatTime(audio.duration);

});



progressBar.addEventListener("input", function () {

    if (audio.duration) {

        audio.currentTime =

            (Number(progressBar.value) / 100) * audio.duration;

    }

});



function formatTime(sec) {

    if (!Number.isFinite(sec) || sec < 0) return "0:00";



    const m = Math.floor(sec / 60);

    const s = Math.floor(sec % 60);



    return m + ":" + String(s).padStart(2, "0");

}



function setPlayIconState(isPlaying) {

    if (!mainPlayIcon) return;



    if (isPlaying) {

        mainPlayIcon.innerHTML =

            '<rect x="6" y="4" width="4" height="16" fill="#ffffff"></rect>' +

            '<rect x="14" y="4" width="4" height="16" fill="#ffffff"></rect>';



    } else {

        mainPlayIcon.innerHTML =

            '<polygon points="6,4 20,12 6,20"></polygon>';

    }

}



/* 9. VIRTUAL PAGINATION */



function computeFilteredList() {

    const query = String(searchInput.value || "")

        .trim()

        .toLowerCase();



    const filter = directorFilter.value || "ALL";



    filteredTrackIndices = [];



    for (let i = 0; i < tracks.length; i++) {

        const t = tracks[i];



        const matchSearch =

            t.title.toLowerCase().includes(query) ||

            t.director.toLowerCase().includes(query);



        const matchDirector =

            filter === "ALL" || t.director === filter;



        if (matchSearch && matchDirector) {

            filteredTrackIndices.push(i);

        }

    }

}



function appendTrackCards(count) {

    const log = getDailyLog();

    const playedSet = new Set(log.playedIds);



    const endIndex = Math.min(

        renderedCount + count,

        filteredTrackIndices.length

    );



    for (let i = renderedCount; i < endIndex; i++) {

        const idx = filteredTrackIndices[i];

        const track = tracks[idx];



        const isCurrent = idx === currentTrackIndex;

        const isPlaying = isCurrent && !audio.paused;

        const isPlayedToday = playedSet.has(track.id);



        const card = document.createElement("div");



        card.className =

            "track-card" +

            (isCurrent ? " active" : "") +

            (isPlayedToday ? " played-today" : "");



        card.innerHTML = `

            <div class="track-main">

                <span class="music-glyph">♬</span>



                <div class="track-text">

                    <div class="track-name">${track.title}</div>



                    <div class="track-sub">

                        ${track.director}

                        ${isPlayedToday

                            ? '<span class="daily-status"> Played Today</span>'

                            : ""}

                    </div>

                </div>

            </div>



            <div class="track-actions">

                <button class="edit-btn"

                    data-action="edit"

                    data-id="${track.id}">Edit</button>



                <button class="delete-btn"

                    data-action="delete"

                    data-id="${track.id}">🗑</button>



                <button class="card-play-btn"

                    data-action="play"

                    data-idx="${idx}">



                    ${isPlaying

                        ? '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>'

                        : '<svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20"></polygon></svg>'}

                </button>

            </div>

        `;



        tracksContainer.appendChild(card);

    }



    renderedCount = endIndex;

}



function renderTrackList(resetList = true) {

    if (!tracksContainer) return;



    if (resetList) {

        computeFilteredList();

        tracksContainer.innerHTML = "";

        renderedCount = 0;

    }



    if (tracks.length === 0) {

        tracksContainer.innerHTML = `

            <div class="empty-state">

                Your library is empty.<br>

                Click <strong>+ Import Track</strong> above to add songs.

            </div>

        `;



        return;

    }



    if (resetList) {

        appendTrackCards(BATCH_SIZE);



    } else {

        const cards = tracksContainer.querySelectorAll(".track-card");



        const log = getDailyLog();

        const playedSet = new Set(log.playedIds);



        cards.forEach((card, domIdx) => {

            const trackIdx = filteredTrackIndices[domIdx];



            if (trackIdx !== undefined) {

                const track = tracks[trackIdx];



                const isCurrent = trackIdx === currentTrackIndex;

                const isPlayedToday = playedSet.has(track.id);



                card.className =

                    "track-card" +

                    (isCurrent ? " active" : "") +

                    (isPlayedToday ? " played-today" : "");



                const playBtn = card.querySelector(".card-play-btn");



                if (playBtn) {

                    playBtn.innerHTML =

                        (isCurrent && !audio.paused)

                            ? '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>'

                            : '<svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20"></polygon></svg>';

                }

            }

        });

    }

}



window.addEventListener("scroll", function () {

    if (window.innerHeight + window.scrollY >=

        document.body.offsetHeight - 500) {



        if (renderedCount < filteredTrackIndices.length) {

            appendTrackCards(BATCH_SIZE);

        }

    }

});



function updateDirectorDropdown() {

    const cur = directorFilter.value || "ALL";



    const dirs = Array.from(

        new Set(tracks.map(function (t) {

            return t.director;

        }))

    ).filter(Boolean).sort();



    directorFilter.innerHTML =

        '<option value="ALL">ALL DIRECTORS</option>';



    dirs.forEach(function (d) {

        const opt = document.createElement("option");



        opt.value = d;

        opt.textContent = d;



        directorFilter.appendChild(opt);

    });



    directorFilter.value =

        Array.from(directorFilter.options).some(function (o) {

            return o.value === cur;

        }) ? cur : "ALL";

}



/* 10. CARD ACTIONS */



tracksContainer.addEventListener("click", async function (e) {

    const btn = e.target.closest("[data-action]");



    if (!btn) return;



    e.stopPropagation();



    const action = btn.dataset.action;



    if (action === "play") {

        const idx = Number(btn.dataset.idx);



        if (idx === currentTrackIndex) {

            if (audio.paused) {

                await playCurrentTrack();

            } else {

                pauseCurrentTrack();

            }



        } else {

            await loadTrackSource(idx);

            await playCurrentTrack();

        }



    } else if (action === "edit") {

        const track = tracks.find(function (t) {

            return t.id === btn.dataset.id;

        });



        if (!track) return;



        activeEditingTrackId = track.id;



        editTitleInput.value = track.title;

        editDirectorInput.value = track.director;



        editModal.classList.add("open");



    } else if (action === "delete") {

        const track = tracks.find(function (t) {

            return t.id === btn.dataset.id;

        });



        if (!track || !confirm(`Delete "${track.title}"?`)) {

            return;

        }



        await removeTrackFromDB(track.id);



        const idx = tracks.indexOf(track);



        if (idx === currentTrackIndex) {

            audio.pause();



            currentTrackIndex = -1;



            dockTitle.textContent = "No track playing";

            dockSubtitle.textContent =

                "Select a song from your library";



            setPlayIconState(false);

        }



        tracks.splice(idx, 1);



        updateDirectorDropdown();

        renderTrackList(true);

    }

});



cancelEditBtn.addEventListener("click", function () {

    editModal.classList.remove("open");

    activeEditingTrackId = null;

});



saveEditBtn.addEventListener("click", async function () {

    if (!activeEditingTrackId) return;



    const track = tracks.find(function (t) {

        return t.id === activeEditingTrackId;

    });



    if (!track) return;



    const t = editTitleInput.value.trim();

    const d = editDirectorInput.value.trim();



    if (!t) {

        alert("Title cannot be empty.");

        return;

    }



    track.title = t;

    track.director = d || "UNKNOWN DIRECTOR";



    const blob = await getTrackAudioBlob(track.id);



    await saveTracksBatch([{

        id: track.id,

        title: track.title,

        director: track.director,

        blob: blob

    }]);



    if (tracks[currentTrackIndex]?.id === track.id) {

        dockTitle.textContent = track.title;

        dockSubtitle.textContent = track.director;

    }



    editModal.classList.remove("open");

    activeEditingTrackId = null;



    updateDirectorDropdown();

    renderTrackList(true);

});



/* 11. BULK IMPORT */



importBtn.addEventListener("click", function () {

    fileSelector.value = "";

    fileSelector.click();

});



fileSelector.addEventListener("change", function (e) {

    const files = Array.from(e.target.files || []);



    if (!files.length) return;



    pendingImportFiles = files;



    if (bulkDirectorModal) {

        bulkDirectorInput.value = "";

        bulkDirectorModal.classList.add("open");



    } else {

        const entered = prompt(

            "Enter Music Director for selected song(s):",

            "UNKNOWN DIRECTOR"

        );



        processImportQueue(

            entered && entered.trim()

                ? entered.trim()

                : "UNKNOWN DIRECTOR"

        );

    }

});



if (skipBulkDirectorBtn) {

    skipBulkDirectorBtn.addEventListener("click", function () {

        bulkDirectorModal.classList.remove("open");

        processImportQueue("UNKNOWN DIRECTOR");

    });

}



if (saveBulkDirectorBtn) {

    saveBulkDirectorBtn.addEventListener("click", function () {

        const directorName =

            bulkDirectorInput.value.trim() || "UNKNOWN DIRECTOR";



        bulkDirectorModal.classList.remove("open");



        processImportQueue(directorName);

    });

}



async function processImportQueue(musicDirector) {

    if (!pendingImportFiles.length) return;



    importBtn.disabled = true;



    const total = pendingImportFiles.length;

    let savedCount = 0;



    const CHUNK_SIZE = 15;



    for (let i = 0; i < total; i += CHUNK_SIZE) {

        const chunk = pendingImportFiles.slice(i, i + CHUNK_SIZE);

        const batchRecords = [];



        for (let j = 0; j < chunk.length; j++) {

            const f = chunk[j];



            const trackRecord = {

                id: "track_" + Date.now() + "_" +

                    Math.random().toString(36).substring(2, 9),



                title: f.name.replace(/\.[^.]+$/, ""),

                director: musicDirector,

                blob: f

            };



            batchRecords.push(trackRecord);



            tracks.push({

                id: trackRecord.id,

                title: trackRecord.title,

                director: trackRecord.director

            });



            savedCount++;

        }



        importBtn.textContent =

            `Saving (${savedCount}/${total})...`;



        await saveTracksBatch(batchRecords);



        await new Promise(r => setTimeout(r, 40));

    }



    pendingImportFiles = [];



    importBtn.disabled = false;

    importBtn.textContent = "+ Import Track";



    fileSelector.value = "";



    updateDirectorDropdown();

    renderTrackList(true);

}



/* 12. BOTTOM CONTROLS */



mainPlayBtn.addEventListener("click", async function () {

    if (audio.paused) {

        await playCurrentTrack();

    } else {

        pauseCurrentTrack();

    }

});



prevBtn.addEventListener("click", playPreviousTrack);

nextBtn.addEventListener("click", advanceToNextTrack);



searchInput.addEventListener("input", function () {

    renderTrackList(true);

});



directorFilter.addEventListener("change", function () {

    renderTrackList(true);

});



/* 13. PWA INSTALL */



window.addEventListener("beforeinstallprompt", function (e) {

    e.preventDefault();



    deferredPrompt = e;



    if (installBar) {

        installBar.style.display = "flex";

    }

});



installTriggerBtn.addEventListener("click", async function () {

    if (!deferredPrompt) return;



    deferredPrompt.prompt();



    const res = await deferredPrompt.userChoice;



    if (res.outcome === "accepted" && installBar) {

        installBar.style.display = "none";

    }



    deferredPrompt = null;

});



/* ============================================================

   14. SETTINGS SYSTEM

   Separate settings storage — does not clear music data.

   ============================================================ */



const SETTINGS_KEY = "rishi_settings_v1";



const DEFAULT_SETTINGS = {

    theme: "dark",

    accent: "#1d72fe",

    speed: 1,

    volume: 100

};



let appSettings = loadAppSettings();



function loadAppSettings() {

    try {

        const saved = JSON.parse(

            localStorage.getItem(SETTINGS_KEY) || "{}"

        );



        return {

            ...DEFAULT_SETTINGS,

            ...saved

        };



    } catch (error) {

        return { ...DEFAULT_SETTINGS };

    }

}



function saveAppSettings() {

    try {

        localStorage.setItem(

            SETTINGS_KEY,

            JSON.stringify(appSettings)

        );



    } catch (error) {

        console.warn("Could not save settings:", error);

    }

}



function hexToRgb(hex) {

    const clean = String(hex).replace("#", "");



    const full = clean.length === 3

        ? clean.split("").map(c => c + c).join("")

        : clean;



    const number = parseInt(full, 16);



    if (!Number.isFinite(number)) {

        return "29,114,254";

    }



    return `${(number >> 16) & 255},${(number >> 8) & 255},${number & 255}`;

}



function applyAppSettings() {

    document.body.dataset.theme =

        appSettings.theme === "light" ? "light" : "dark";



    document.documentElement.style.setProperty(

        "--accent",

        appSettings.accent

    );



    document.documentElement.style.setProperty(

        "--accent-rgb",

        hexToRgb(appSettings.accent)

    );



    audio.playbackRate = Number(appSettings.speed) || 1;



    audio.volume = Math.max(

        0,

        Math.min(1, Number(appSettings.volume) / 100)

    );



    const themeMeta = document.querySelector(

        'meta[name="theme-color"]'

    );



    if (themeMeta) {

        themeMeta.content =

            appSettings.theme === "light"

                ? "#f4f7fb"

                : "#08090d";

    }

}



/* Settings DOM */



const settingsModal = document.getElementById("settingsModal");

const settingsBtn = document.getElementById("settingsBtn");



const closeSettingsBtn =

    document.getElementById("closeSettingsBtn");



const doneSettingsBtn =

    document.getElementById("doneSettingsBtn");



const resetSettingsBtn =

    document.getElementById("resetSettingsBtn");



const themeSelect =

    document.getElementById("themeSelect");



const accentColor =

    document.getElementById("accentColor");



const accentHex =

    document.getElementById("accentHex");



const playbackSpeed =

    document.getElementById("playbackSpeed");



const defaultVolume =

    document.getElementById("defaultVolume");



const volumeValue =

    document.getElementById("volumeValue");



const settingsTrackCount =

    document.getElementById("settingsTrackCount");



const storageUsage =

    document.getElementById("storageUsage");



/* Open settings */



function openSettings() {

    if (!settingsModal) return;



    themeSelect.value = appSettings.theme;



    accentColor.value = appSettings.accent;



    accentHex.value =

        appSettings.accent.toUpperCase();



    playbackSpeed.value =

        String(appSettings.speed);



    defaultVolume.value =

        String(appSettings.volume);



    volumeValue.textContent =

        `${appSettings.volume}%`;



    if (settingsTrackCount) {

        settingsTrackCount.textContent =

            String(tracks.length);

    }



    settingsModal.classList.add("open");



    settingsModal.setAttribute(

        "aria-hidden",

        "false"

    );



    updateStorageEstimate();

}



/* Close settings */



function closeSettings() {

    if (!settingsModal) return;



    settingsModal.classList.remove("open");



    settingsModal.setAttribute(

        "aria-hidden",

        "true"

    );

}



/* Update and save settings */



function updateSetting(changes) {

    appSettings = {

        ...appSettings,

        ...changes

    };



    saveAppSettings();

    applyAppSettings();

}



/* Storage estimate */



function updateStorageEstimate() {

    if (!storageUsage) return;



    if (!navigator.storage ||

        !navigator.storage.estimate) {



        storageUsage.textContent =

            "Not available in this browser";



        return;

    }



    navigator.storage.estimate().then(info => {

        const used = Number(info.usage || 0);

        const mb = used / (1024 * 1024);



        storageUsage.textContent =

            mb >= 1024

                ? `${(mb / 1024).toFixed(2)} GB`

                : `${mb.toFixed(1)} MB`;



    }).catch(() => {

        storageUsage.textContent = "Unavailable";

    });

}



/* Settings button */



if (settingsBtn) {

    settingsBtn.addEventListener("click", openSettings);

}



if (closeSettingsBtn) {

    closeSettingsBtn.addEventListener("click", closeSettings);

}



if (doneSettingsBtn) {

    doneSettingsBtn.addEventListener("click", closeSettings);

}



/* Close when clicking outside */



if (settingsModal) {

    settingsModal.addEventListener("click", function (e) {

        if (e.target === settingsModal) {

            closeSettings();

        }

    });

}



/* Theme selection */



if (themeSelect) {

    themeSelect.addEventListener("change", function () {

        updateSetting({

            theme: themeSelect.value

        });

    });

}



/* RGB colour picker */



if (accentColor) {

    accentColor.addEventListener("input", function () {

        const value = accentColor.value;



        accentHex.value = value.toUpperCase();



        updateSetting({

            accent: value

        });

    });

}



/* HEX colour input */



if (accentHex) {

    accentHex.addEventListener("change", function () {

        const value = accentHex.value.trim();



        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {



            const normalized = value.length === 4

                ? "#" + value.slice(1)

                    .split("")

                    .map(c => c + c)

                    .join("")

                : value;



            accentColor.value = normalized;



            accentHex.value =

                normalized.toUpperCase();



            updateSetting({

                accent: normalized

            });



        } else {

            accentHex.value =

                appSettings.accent.toUpperCase();



            alert(

                "Enter a valid HEX colour, such as #1D72FE."

            );

        }

    });

}



/* Playback speed */



if (playbackSpeed) {

    playbackSpeed.addEventListener("change", function () {

        updateSetting({

            speed: Number(playbackSpeed.value)

        });

    });

}



/* Volume */



if (defaultVolume) {

    defaultVolume.addEventListener("input", function () {

        const value = Number(defaultVolume.value);



        volumeValue.textContent = `${value}%`;



        updateSetting({

            volume: value

        });

    });

}



/* Reset settings only — never touches music database */



if (resetSettingsBtn) {

    resetSettingsBtn.addEventListener("click", function () {

        appSettings = { ...DEFAULT_SETTINGS };



        saveAppSettings();

        applyAppSettings();

        openSettings();

    });

}



/* Apply saved settings */



applyAppSettings();



/* 15. INITIALIZE */



initDB().then(async function () {

    tracks = await getAllTracksMetadata();



    updateDirectorDropdown();



    renderTrackList(true);



}).catch(function (error) {

    console.error("Rishi Music database error:", error);



    alert(

        "Unable to open your music library. Please do not clear browser storage."

    );

});


/* ============================================================
   RISHI MUSIC — 15 FEATURE EXTENSION
   Uses the existing RishiMusicDB_v4 / audio_library.
   Never clears, deletes, or recreates the music database.
   ============================================================ */
(function RishiMusicPremiumFeatures() {
    "use strict";

    const FEATURE_KEY = "rishi_music_features_v1";
    const $ = (id) => document.getElementById(id);
    const safeParse = (value, fallback) => {
        try { return value ? JSON.parse(value) : fallback; }
        catch (_) { return fallback; }
    };

    const featureData = safeParse(localStorage.getItem(FEATURE_KEY), {
        tracks: {}, queue: [], history: [], totalSeconds: 0,
        crossfade: false, reverb: 0, width: 0, bass: 0, mid: 0,
        treble: 0, frequency: 1000, theme: "blue"
    });

    featureData.tracks ||= {};
    featureData.queue ||= [];
    featureData.history ||= [];

    function saveFeatureData() {
        try { localStorage.setItem(FEATURE_KEY, JSON.stringify(featureData)); }
        catch (e) { console.warn("Rishi Music feature storage is full:", e); }
    }

    function metaFor(id) {
        featureData.tracks[id] ||= {
            lyrics: "", art: "", favorite: false, plays: 0,
            lastPlayed: 0, folder: ""
        };
        return featureData.tracks[id];
    }

    function currentTrack() {
        return typeof tracks !== "undefined" && currentTrackIndex >= 0
            ? tracks[currentTrackIndex] : null;
    }

    function escapeHTML(value) {
        return String(value ?? "").replace(/[&<>"']/g, c => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        }[c]));
    }

    const style = document.createElement("style");
    style.textContent = `
    #rmx-tools{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
    .rmx-btn{border:1px solid var(--panel-border,#192033);background:var(--panel,#11141c);color:var(--text,#fff);border-radius:12px;padding:10px 12px;font-weight:650;cursor:pointer}
    .rmx-btn.primary{background:var(--accent,#1d72fe);color:#fff;border-color:transparent}
    #rmx-dashboard{background:var(--panel,#11141c);border:1px solid var(--panel-border,#192033);border-radius:18px;padding:14px;margin:12px 0;color:var(--text,#fff)}
    #rmx-dashboard h3{margin:0 0 10px;font-size:16px}
    .rmx-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
    .rmx-stat{background:rgba(127,127,127,.09);border-radius:12px;padding:11px;min-width:0}
    .rmx-stat b{display:block;font-size:19px;margin-top:4px;overflow-wrap:anywhere}
    .rmx-muted{color:var(--muted,#64748b);font-size:12px}
    .rmx-modal{display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.78);padding:16px;align-items:center;justify-content:center}
    .rmx-modal.open{display:flex}
    .rmx-sheet{width:min(620px,100%);max-height:88vh;overflow:auto;background:var(--panel,#11141c);color:var(--text,#fff);border:1px solid var(--panel-border,#192033);border-radius:20px;padding:18px}
    .rmx-sheet h2{font-size:20px;margin:0 0 14px}
    .rmx-sheet label{display:block;margin:12px 0 6px;font-size:13px;color:var(--muted,#94a3b8)}
    .rmx-sheet input[type=text],.rmx-sheet input[type=number],.rmx-sheet textarea,.rmx-sheet select{width:100%;padding:11px;border-radius:10px;border:1px solid var(--panel-border,#334155);background:var(--bg,#08090d);color:var(--text,#fff)}
    .rmx-sheet textarea{min-height:150px;resize:vertical}
    .rmx-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
    .rmx-cover{width:42px;height:42px;border-radius:10px;object-fit:cover;background:linear-gradient(135deg,#1d72fe,#111827);display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:800;flex:none}
    .rmx-now-art{width:76px;height:76px;border-radius:16px;object-fit:cover;background:linear-gradient(135deg,#1d72fe,#111827);display:block;margin:0 auto 12px}
    #rmx-visualizer{width:100%;height:90px;display:block;background:rgba(0,0,0,.18);border-radius:12px;margin:10px 0}
    #rmx-lyrics-line{text-align:center;min-height:32px;font-weight:700;margin:8px 0;color:var(--accent,#1d72fe)}
    #rmx-lyrics-list{max-height:190px;overflow:auto;text-align:center;line-height:1.8}
    #rmx-lyrics-list .active{color:var(--accent,#1d72fe);font-weight:800}
    #rmx-queue-list,.rmx-list{display:grid;gap:8px}
    .rmx-row{display:flex;align-items:center;gap:8px;padding:9px;border-radius:11px;background:rgba(127,127,127,.08)}
    .rmx-row .grow{flex:1;min-width:0}
    .rmx-row small{display:block;color:var(--muted,#94a3b8)}
    .rmx-mini #bottomDock,.rmx-mini .bottom-dock{padding:7px!important}
    .rmx-mini #bottomDock .progress-wrap,.rmx-mini .progress-wrap{display:none!important}
    .rmx-mini #bottomDock{max-width:390px;right:12px;left:auto;border-radius:16px}
    .rmx-track-actions{display:flex;gap:5px;margin-left:6px}
    .rmx-track-actions button{font-size:12px;padding:6px 8px}
    @media(min-width:700px){.rmx-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
    `;
    document.head.appendChild(style);

    const host = document.createElement("section");
    host.innerHTML = `
      <div id="rmx-dashboard">
        <h3>✦ RISHI MUSIC PRO DASHBOARD</h3>
        <div class="rmx-grid">
          <div class="rmx-stat"><span class="rmx-muted">Songs in library</span><b id="rmx-total">0</b></div>
          <div class="rmx-stat"><span class="rmx-muted">Total plays</span><b id="rmx-plays">0</b></div>
          <div class="rmx-stat"><span class="rmx-muted">Listening time</span><b id="rmx-time">0 min</b></div>
          <div class="rmx-stat"><span class="rmx-muted">Favourite songs</span><b id="rmx-favs">0</b></div>
        </div>
        <p class="rmx-muted" id="rmx-topline" style="margin-top:10px">Recently played and most played songs will appear here.</p>
      </div>
      <div id="rmx-tools">
        <button class="rmx-btn primary" data-open="player">♫ Player & Lyrics</button>
        <button class="rmx-btn" data-open="queue">Queue</button>
        <button class="rmx-btn" data-open="playlists">Smart Playlists</button>
        <button class="rmx-btn" data-open="folders">Folders</button>
        <button class="rmx-btn" data-open="audio">Equalizer & Effects</button>
        <button class="rmx-btn" data-open="backup">Backup / Restore</button>
        <button class="rmx-btn" data-open="stats">Statistics</button>
        <button class="rmx-btn" id="rmx-mini-toggle">Mini Player</button>
      </div>
      <div class="rmx-modal" id="rmx-modal"><div class="rmx-sheet">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <h2 id="rmx-modal-title">Rishi Music</h2><button class="rmx-btn" id="rmx-close">✕</button>
        </div>
        <div id="rmx-modal-content"></div>
      </div></div>`;
    const insertionPoint = document.querySelector("#tracksContainer")?.parentElement || document.body;
    insertionPoint.insertBefore(host, document.querySelector("#tracksContainer") || null);

    const modal = $("rmx-modal");
    const modalTitle = $("rmx-modal-title");
    const modalContent = $("rmx-modal-content");
    const openModal = (title, html) => {
        modalTitle.textContent = title;
        modalContent.innerHTML = html;
        modal.classList.add("open");
    };
    $("rmx-close").addEventListener("click", () => modal.classList.remove("open"));
    modal.addEventListener("click", e => { if (e.target === modal) modal.classList.remove("open"); });

    function coverMarkup(track, sizeClass = "") {
        const m = track ? metaFor(track.id) : {};
        return m?.art
            ? `<img class="rmx-cover ${sizeClass}" src="${m.art}" alt="Album cover">`
            : `<span class="rmx-cover ${sizeClass}">♫</span>`;
    }

    function updateDashboard() {
        const list = tracks || [];
        const metas = list.map(t => metaFor(t.id));
        $("rmx-total").textContent = list.length;
        $("rmx-plays").textContent = metas.reduce((n,m) => n + (m.plays || 0), 0);
        $("rmx-favs").textContent = metas.filter(m => m.favorite).length;
        const mins = Math.floor((featureData.totalSeconds || 0) / 60);
        $("rmx-time").textContent = mins < 60 ? `${mins} min` : `${Math.floor(mins/60)}h ${mins%60}m`;
        const recent = [...list].filter(t => metaFor(t.id).lastPlayed).sort((a,b) => metaFor(b.id).lastPlayed - metaFor(a.id).lastPlayed)[0];
        const top = [...list].sort((a,b) => metaFor(b.id).plays - metaFor(a.id).plays)[0];
        $("rmx-topline").textContent = `${recent ? "Recently played: " + recent.title : "No recent plays yet."}${top && metaFor(top.id).plays ? "  •  Most played: " + top.title : ""}`;
    }

    function renderLyrics(track) {
        if (!track) return;
        const m = metaFor(track.id);
        const lines = (m.lyrics || "").split(/\r?\n/).map(line => {
            const match = line.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/);
            return match ? { time: Number(match[1])*60 + Number(match[2]) + Number("0."+(match[3] || "0")), text: match[4] } : { time: null, text: line };
        }).filter(x => x.text.trim());
        const timedLines = lines.filter(x => x.time !== null);
        const active = timedLines.filter(x => x.time <= (audio.currentTime || 0)).pop();
        $("rmx-lyrics-line").textContent = active?.text || (lines.length && !timedLines.length ? lines[0].text : "Add LRC lyrics to see synchronized lines");
        const list = $("rmx-lyrics-list");
        if (list) list.innerHTML = lines.map(x => `<div class="${x === active ? "active" : ""}">${escapeHTML(x.text)}</div>`).join("");
    }

    function showPlayer() {
        const t = currentTrack();
        const m = t ? metaFor(t.id) : null;
        openModal("Player • Lyrics • Album Art", `
          ${coverMarkup(t, "rmx-now-art")}
          <div style="text-align:center;font-weight:800">${escapeHTML(t?.title || "No song selected")}</div>
          <div class="rmx-muted" style="text-align:center">${escapeHTML(t?.director || "Choose a song from your library")}</div>
          <canvas id="rmx-visualizer"></canvas>
          <div id="rmx-lyrics-line"></div><div id="rmx-lyrics-list"></div>
          <label>Lyrics (plain text or LRC timestamps like [00:12.50])</label>
          <textarea id="rmx-lyrics-input" placeholder="[00:05.00]First lyric line&#10;[00:10.00]Second lyric line">${escapeHTML(m?.lyrics || "")}</textarea>
          <label>Album cover for this song</label><input id="rmx-art-input" type="file" accept="image/*">
          <div class="rmx-actions">
            <button class="rmx-btn primary" id="rmx-save-lyrics">Save lyrics</button>
            <button class="rmx-btn" id="rmx-favorite">${m?.favorite ? "★ Remove favourite" : "☆ Add favourite"}</button>
            <button class="rmx-btn" id="rmx-add-queue">Add to queue</button>
          </div>`);
        renderLyrics(t);
        $("rmx-save-lyrics")?.addEventListener("click", () => {
            if (!t) return;
            metaFor(t.id).lyrics = $("rmx-lyrics-input").value;
            saveFeatureData(); renderLyrics(t); alert("Lyrics saved for this song.");
        });
        $("rmx-favorite")?.addEventListener("click", () => {
            if (!t) return;
            metaFor(t.id).favorite = !metaFor(t.id).favorite;
            saveFeatureData(); showPlayer(); updateDashboard();
        });
        $("rmx-add-queue")?.addEventListener("click", () => {
            if (t) addToQueue(t.id);
        });
        $("rmx-art-input")?.addEventListener("change", async e => {
            if (!t || !e.target.files[0]) return;
            const data = await resizeImage(e.target.files[0]);
            if (!data) return alert("Could not read this image.");
            metaFor(t.id).art = data; saveFeatureData(); showPlayer();
        });
        startVisualizer();
    }

    function resizeImage(file) {
        return new Promise(resolve => {
            if (!file.type.startsWith("image/")) return resolve(null);
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                const canvas = document.createElement("canvas");
                const scale = Math.min(1, 420 / Math.max(img.width, img.height));
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);
                URL.revokeObjectURL(url);
                resolve(canvas.toDataURL("image/jpeg", .78));
            };
            img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
            img.src = url;
        });
    }

    let audioCtx = null, mediaSource = null, analyser = null;
    let bassFilter = null, midFilter = null, trebleFilter = null, reverbNode = null;
    let dryGain = null, wetGain = null, visualFrame = 0;
    let splitter = null, merger = null, ll = null, lr = null, rl = null, rr = null;
    function setupAudioGraph() {
        if (audioCtx) return true;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC || !audio) return false;
        try {
            audioCtx = new AC();
            mediaSource = audioCtx.createMediaElementSource(audio);
            bassFilter = audioCtx.createBiquadFilter(); bassFilter.type = "lowshelf"; bassFilter.frequency.value = 180;
            midFilter = audioCtx.createBiquadFilter(); midFilter.type = "peaking"; midFilter.frequency.value = featureData.frequency || 1000; midFilter.Q.value = 1;
            trebleFilter = audioCtx.createBiquadFilter(); trebleFilter.type = "highshelf"; trebleFilter.frequency.value = 4500;
            analyser = audioCtx.createAnalyser(); analyser.fftSize = 128;
            splitter = audioCtx.createChannelSplitter(2);
            merger = audioCtx.createChannelMerger(2);
            ll = audioCtx.createGain(); lr = audioCtx.createGain();
            rl = audioCtx.createGain(); rr = audioCtx.createGain();
            dryGain = audioCtx.createGain(); wetGain = audioCtx.createGain();
            reverbNode = audioCtx.createConvolver();
            const length = audioCtx.sampleRate * 1.6;
            const impulse = audioCtx.createBuffer(2, length, audioCtx.sampleRate);
            for (let ch=0; ch<2; ch++) {
                const data = impulse.getChannelData(ch);
                for (let i=0; i<length; i++) data[i] = (Math.random()*2-1) * Math.pow(1-i/length, 2.4);
            }
            reverbNode.buffer = impulse;
            mediaSource.connect(bassFilter);
            bassFilter.connect(midFilter); midFilter.connect(trebleFilter);
            // Mid/side-style stereo width matrix. 100% preserves the original stereo image.
            trebleFilter.connect(splitter);
            splitter.connect(ll,0); ll.connect(merger,0,0);
            splitter.connect(lr,1); lr.connect(merger,0,0);
            splitter.connect(rl,0); rl.connect(merger,0,1);
            splitter.connect(rr,1); rr.connect(merger,0,1);
            merger.connect(analyser);
            analyser.connect(dryGain); dryGain.connect(audioCtx.destination);
            merger.connect(reverbNode); reverbNode.connect(wetGain); wetGain.connect(audioCtx.destination);
            applyAudioSettings();
            return true;
        } catch (e) {
            console.warn("Audio effects are not supported in this browser:", e);
            audioCtx = null; return false;
        }
    }

    function applyAudioSettings() {
        if (!setupAudioGraph()) return;
        bassFilter.gain.value = Number(featureData.bass || 0);
        midFilter.gain.value = Number(featureData.mid || 0);
        midFilter.frequency.value = Number(featureData.frequency || 1000);
        trebleFilter.gain.value = Number(featureData.treble || 0);
        wetGain.gain.value = Number(featureData.reverb || 0) / 100 * .45;
        dryGain.gain.value = 1;
        const width = Math.max(0, Math.min(200, Number(featureData.width ?? 100))) / 100;
        const direct = (1 + width) / 2, cross = (1 - width) / 2;
        ll.gain.value = direct; rr.gain.value = direct;
        lr.gain.value = cross; rl.gain.value = cross;
    }

    function startVisualizer() {
        if (!setupAudioGraph()) return;
        audioCtx.resume().catch(()=>{});
        const canvas = $("rmx-visualizer");
        if (!canvas || !analyser) return;
        const ctx = canvas.getContext("2d");
        const draw = () => {
            if (!canvas.isConnected) { cancelAnimationFrame(visualFrame); return; }
            const width = canvas.clientWidth || 300, height = canvas.clientHeight || 90;
            if (canvas.width !== width*devicePixelRatio || canvas.height !== height*devicePixelRatio) {
                canvas.width = width*devicePixelRatio; canvas.height = height*devicePixelRatio;
            }
            ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
            const data = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(data);
            ctx.clearRect(0,0,width,height);
            const gap = 3, bars = data.length, bw = Math.max(2,(width-gap*(bars-1))/bars);
            data.forEach((v,i) => {
                const h = Math.max(2,(v/255)*height);
                ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#1d72fe";
                ctx.fillRect(i*(bw+gap),height-h,bw,h);
            });
            visualFrame = requestAnimationFrame(draw);
        };
        cancelAnimationFrame(visualFrame); draw();
    }

    function showAudioSettings() {
        openModal("Advanced Equalizer & Audio Effects", `
          <label>Bass <span id="rmx-bass-val">${featureData.bass} dB</span></label><input id="rmx-bass" type="range" min="-12" max="12" value="${featureData.bass}">
          <label>Mid <span id="rmx-mid-val">${featureData.mid} dB</span></label><input id="rmx-mid" type="range" min="-12" max="12" value="${featureData.mid}">
          <label>Treble <span id="rmx-treble-val">${featureData.treble} dB</span></label><input id="rmx-treble" type="range" min="-12" max="12" value="${featureData.treble}">
          <label>Mid frequency: <span id="rmx-freq-val">${featureData.frequency} Hz</span></label><input id="rmx-freq" type="range" min="250" max="8000" step="50" value="${featureData.frequency}">
          <label>Reverb <span id="rmx-reverb-val">${featureData.reverb}%</span></label><input id="rmx-reverb" type="range" min="0" max="100" value="${featureData.reverb}">
          <label>Stereo width <span id="rmx-width-val">${featureData.width ?? 100}%</span></label><input id="rmx-width" type="range" min="0" max="200" value="${featureData.width ?? 100}">
          <label><input id="rmx-crossfade" type="checkbox" ${featureData.crossfade ? "checked" : ""}> Enable 5-second fade-out transition</label>
          <p class="rmx-muted">Effects use your browser's Web Audio support. Reverb is generated locally. Sound may differ by device.</p>
          <div class="rmx-actions"><button class="rmx-btn" id="rmx-eq-reset">Reset equalizer</button></div>`);
        const bind = (id,key,labelId,suffix) => $(id).addEventListener("input",e=>{
            featureData[key]=Number(e.target.value);
            $(labelId).textContent=featureData[key]+suffix;
            saveFeatureData(); applyAudioSettings();
        });
        bind("rmx-bass","bass","rmx-bass-val"," dB");
        bind("rmx-mid","mid","rmx-mid-val"," dB");
        bind("rmx-treble","treble","rmx-treble-val"," dB");
        bind("rmx-freq","frequency","rmx-freq-val"," Hz");
        bind("rmx-reverb","reverb","rmx-reverb-val","%");
        bind("rmx-width","width","rmx-width-val","%");
        $("rmx-crossfade").addEventListener("change",e=>{featureData.crossfade=e.target.checked;saveFeatureData();});
        $("rmx-eq-reset").addEventListener("click",()=>{
            Object.assign(featureData,{bass:0,mid:0,treble:0,reverb:0,frequency:1000});
            saveFeatureData();showAudioSettings();applyAudioSettings();
        });
    }

    function addToQueue(id) {
        if (!tracks.some(t=>t.id===id)) return;
        if (!featureData.queue.includes(id)) featureData.queue.push(id);
        saveFeatureData(); alert("Added to upcoming queue.");
    }

    function showQueue() {
        const items = featureData.queue.map((id,i)=>{
            const t=tracks.find(x=>x.id===id); return t?{id,t,i}:null;
        }).filter(Boolean);
        openModal("Upcoming Queue", `<div id="rmx-queue-list">${items.length?items.map(x=>`
          <div class="rmx-row"><div class="grow"><b>${escapeHTML(x.t.title)}</b><small>${escapeHTML(x.t.director)}</small></div>
          <button class="rmx-btn" data-q-up="${x.i}">↑</button><button class="rmx-btn" data-q-down="${x.i}">↓</button><button class="rmx-btn" data-q-remove="${x.id}">✕</button></div>`).join(""):"<p class='rmx-muted'>Your queue is empty. Add tracks from the library.</p>"}</div>
          <div class="rmx-actions"><button class="rmx-btn" id="rmx-clear-queue">Clear queue</button></div>`);
        modalContent.querySelectorAll("[data-q-remove]").forEach(b=>b.onclick=()=>{featureData.queue=featureData.queue.filter(id=>id!==b.dataset.qRemove);saveFeatureData();showQueue();});
        modalContent.querySelectorAll("[data-q-up]").forEach(b=>b.onclick=()=>{const i=+b.dataset.qUp;if(i>0)[featureData.queue[i-1],featureData.queue[i]]=[featureData.queue[i],featureData.queue[i-1]];saveFeatureData();showQueue();});
        modalContent.querySelectorAll("[data-q-down]").forEach(b=>b.onclick=()=>{const i=+b.dataset.qDown;if(i<featureData.queue.length-1)[featureData.queue[i+1],featureData.queue[i]]=[featureData.queue[i],featureData.queue[i+1]];saveFeatureData();showQueue();});
        $("rmx-clear-queue").onclick=()=>{featureData.queue=[];saveFeatureData();showQueue();};
    }

    // Queue has priority over the existing daily random rotation.
    const originalNextIndex = getNextUnplayedIndex;
    getNextUnplayedIndex = function() {
        while (featureData.queue.length) {
            const id=featureData.queue.shift();
            const idx=tracks.findIndex(t=>t.id===id);
            if (idx>=0 && idx!==currentTrackIndex) { saveFeatureData(); return idx; }
        }
        return originalNextIndex();
    };

    function showPlaylists() {
        const fav=tracks.filter(t=>metaFor(t.id).favorite);
        const most=[...tracks].sort((a,b)=>metaFor(b.id).plays-metaFor(a.id).plays).filter(t=>metaFor(t.id).plays);
        const recent=[...tracks].filter(t=>metaFor(t.id).lastPlayed).sort((a,b)=>metaFor(b.id).lastPlayed-metaFor(a.id).lastPlayed);
        const unplayed=tracks.filter(t=>!metaFor(t.id).plays);
        const render=(title,list)=>`<h3 style="margin:14px 0 7px">${title} (${list.length})</h3><div class="rmx-list">${list.slice(0,30).map(t=>`<div class="rmx-row">${coverMarkup(t)}<div class="grow"><b>${escapeHTML(t.title)}</b><small>${escapeHTML(t.director)}</small></div><button class="rmx-btn" data-play-id="${t.id}">▶</button></div>`).join("") || "<p class='rmx-muted'>No songs yet.</p>"}</div>`;
        openModal("Smart Playlists",render("★ Favourites",fav)+render("Most played",most)+render("Recently played",recent)+render("Not yet played",unplayed));
        modalContent.querySelectorAll("[data-play-id]").forEach(b=>b.onclick=async()=>{const i=tracks.findIndex(t=>t.id===b.dataset.playId);if(i>=0){await loadTrackSource(i);await playCurrentTrack();modal.classList.remove("open");}});
    }

    function showFolders() {
        openModal("Folder Browser",`
          <p class="rmx-muted">Choose a folder to import its audio files. Folder access depends on browser support and your permission.</p>
          <input id="rmx-folder-input" type="file" webkitdirectory directory multiple accept="audio/*">
          <div id="rmx-folder-list" class="rmx-list" style="margin-top:14px"></div>`);
        const input=$("rmx-folder-input");
        input.addEventListener("change",async()=>{
            const files=[...input.files].filter(f=>f.type.startsWith("audio/")||/\.(mp3|m4a|aac|wav|ogg|flac|opus)$/i.test(f.name));
            if(!files.length)return alert("No supported audio files found in this folder.");
            if(!confirm(`Import ${files.length} audio files into your existing library?`))return;
            const known=new Set(tracks.map(t=>t.title.toLowerCase()+"|"+t.director.toLowerCase()));
            const batch=[];
            for(const f of files){
                const title=f.name.replace(/\.[^.]+$/,"");
                const id="track_"+Date.now()+"_"+Math.random().toString(36).slice(2,9);
                batch.push({id,title,director:"UNKNOWN DIRECTOR",blob:f});
                metaFor(id).folder=f.webkitRelativePath.split("/").slice(0,-1).join("/")||"Selected folder";
            }
            try{
                await saveTracksBatch(batch);
                tracks.push(...batch.map(({id,title,director})=>({id,title,director})));
                saveFeatureData();updateDirectorDropdown();renderTrackList(true);updateDashboard();
                alert(`Imported ${batch.length} tracks.`);
            }catch(e){alert("Folder import failed: "+e.message);}
        });
        const dirs=[...new Set(tracks.map(t=>metaFor(t.id).folder).filter(Boolean))];
        $("rmx-folder-list").innerHTML=dirs.length?dirs.map(d=>`<div class="rmx-row">${escapeHTML(d)}</div>`).join(""):"<p class='rmx-muted'>Folder information will appear for songs imported using this folder picker.</p>";
    }

    function showStats() {
        const total=tracks.reduce((n,t)=>n+metaFor(t.id).plays,0);
        const directors={};
        tracks.forEach(t=>directors[t.director]=(directors[t.director]||0)+metaFor(t.id).plays);
        const topDirs=Object.entries(directors).sort((a,b)=>b[1]-a[1]).slice(0,10);
        const topSongs=[...tracks].sort((a,b)=>metaFor(b.id).plays-metaFor(a.id).plays).slice(0,10);
        openModal("Listening Statistics",`
          <div class="rmx-grid">
            <div class="rmx-stat">Songs<b>${tracks.length}</b></div>
            <div class="rmx-stat">Plays<b>${total}</b></div>
            <div class="rmx-stat">Listening time<b>${Math.floor(featureData.totalSeconds/3600)}h ${Math.floor(featureData.totalSeconds%3600/60)}m</b></div>
            <div class="rmx-stat">Favourites<b>${tracks.filter(t=>metaFor(t.id).favorite).length}</b></div>
          </div>
          <h3 style="margin:16px 0 8px">Top songs</h3>${topSongs.map(t=>`<div class="rmx-row"><div class="grow">${escapeHTML(t.title)}<small>${metaFor(t.id).plays} plays</small></div></div>`).join("")}
          <h3 style="margin:16px 0 8px">Favourite music directors by plays</h3>${topDirs.map(([d,n])=>`<div class="rmx-row"><div class="grow">${escapeHTML(d)}</div><b>${n}</b></div>`).join("")}`);
    }

    function blobToDataURL(blob) {
        return new Promise((resolve,reject)=>{
            const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);
        });
    }
    function dataURLToBlob(dataURL) {
        const [head,data]=dataURL.split(",");
        const mime=(head.match(/:(.*?);/)||[])[1]||"audio/mpeg";
        const binary=atob(data),bytes=new Uint8Array(binary.length);
        for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
        return new Blob([bytes],{type:mime});
    }

    function showBackup() {
        openModal("Backup & Restore",`
          <p class="rmx-muted">A metadata backup saves titles, directors, playlists, lyrics, artwork references, statistics and settings. A full backup also includes every audio file and can be very large. Keep your original music files too.</p>
          <div class="rmx-actions">
            <button class="rmx-btn primary" id="rmx-export-meta">Export information backup</button>
            <button class="rmx-btn" id="rmx-export-full">Export FULL backup (includes audio)</button>
          </div>
          <label>Restore a Rishi Music JSON backup</label><input id="rmx-restore-file" type="file" accept="application/json,.json">
          <p class="rmx-muted">Restore adds missing tracks and does not overwrite existing track IDs or clear your current library.</p>`);
        const download=(data,name)=>{
            const blob=new Blob([JSON.stringify(data)],{type:"application/json"});
            const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
        };
        const snapshot=async includeAudio=>{
            const payload={format:"RishiMusicBackup",version:1,createdAt:new Date().toISOString(),settings:safeParse(localStorage.getItem("rishi_settings_v1"),{}),daily:safeParse(localStorage.getItem("rishi_daily_plays_v4"),{}),features:featureData,tracks:[]};
            const tx=db.transaction([STORE_NAME],"readonly"),store=tx.objectStore(STORE_NAME);
            const req=store.openCursor();
            const rows=[];
            await new Promise((resolve,reject)=>{
                req.onsuccess=e=>{
                    const c=e.target.result;
                    if(!c){resolve();return;}
                    const v=c.value;
                    rows.push({id:v.id,title:v.title,director:v.director,blob:v.blob||null});
                    c.continue();
                };
                req.onerror=()=>reject(req.error);
            });
            for (const row of rows) {
                const item={id:row.id,title:row.title,director:row.director};
                if(includeAudio&&row.blob) item.audio=await blobToDataURL(row.blob);
                payload.tracks.push(item);
            }
            return payload;
        };
        $("rmx-export-meta").onclick=async()=>{try{const d=await snapshot(false);download(d,"rishi-music-information-backup.json");}catch(e){alert("Backup failed: "+e.message);}};
        $("rmx-export-full").onclick=async()=>{
            if(!confirm("Full backup may require substantial phone/computer memory and storage. Continue?"))return;
            try{const d=await snapshot(true);download(d,"rishi-music-full-backup.json");}catch(e){alert("Full backup failed. Try the information-only backup instead. "+e.message);}
        };
        $("rmx-restore-file").addEventListener("change",async e=>{
            const file=e.target.files[0];if(!file)return;
            if(!confirm("Restore this backup? Existing tracks will be kept; only missing track IDs are added."))return;
            try{
                const backup=JSON.parse(await file.text());
                if(backup.format!=="RishiMusicBackup"||!Array.isArray(backup.tracks))throw new Error("This is not a valid Rishi Music backup.");
                const existing=new Set(tracks.map(t=>t.id)),batch=[];
                for(const row of backup.tracks){
                    if(!row.id||existing.has(row.id))continue;
                    if(row.audio)batch.push({id:row.id,title:row.title||"Unknown",director:row.director||"UNKNOWN DIRECTOR",blob:dataURLToBlob(row.audio)});
                    else batch.push({id:row.id,title:row.title||"Unknown",director:row.director||"UNKNOWN DIRECTOR",blob:null});
                }
                const withAudio=batch.filter(x=>x.blob);
                if(withAudio.length)await saveTracksBatch(withAudio);
                tracks.push(...withAudio.map(({id,title,director})=>({id,title,director})));
                if(backup.features&&typeof backup.features==="object"){
                    Object.assign(featureData,backup.features);saveFeatureData();
                }
                if(backup.settings)localStorage.setItem("rishi_settings_v1",JSON.stringify({...safeParse(localStorage.getItem("rishi_settings_v1"),{}),...backup.settings}));
                if(backup.daily)localStorage.setItem("rishi_daily_plays_v4",JSON.stringify(backup.daily));
                updateDirectorDropdown();renderTrackList(true);updateDashboard();
                alert(`Restore finished. Added ${withAudio.length} songs with audio. Metadata-only entries were not imported as playable tracks.`);
            }catch(err){alert("Restore failed: "+err.message);}
        });
    }

    // Add favourite/queue actions to the existing virtualized track cards.
    function enhanceTrackCards() {
        document.querySelectorAll(".track-card").forEach(card=>{
            if(card.dataset.rmxEnhanced)return;
            const play=card.querySelector('[data-action="play"]');
            const idx=Number(play?.dataset.idx);
            const t=Number.isInteger(idx)?tracks[idx]:null;
            if(!t)return;
            card.dataset.rmxEnhanced="1";
            const area=document.createElement("div");area.className="rmx-track-actions";
            const fav=document.createElement("button");fav.className="rmx-btn";fav.textContent=metaFor(t.id).favorite?"★":"☆";fav.title="Favourite";
            fav.onclick=()=>{metaFor(t.id).favorite=!metaFor(t.id).favorite;saveFeatureData();fav.textContent=metaFor(t.id).favorite?"★":"☆";updateDashboard();};
            const q=document.createElement("button");q.className="rmx-btn";q.textContent="+ Queue";q.onclick=()=>addToQueue(t.id);
            area.append(fav,q);card.querySelector(".track-actions")?.append(area);
            const main=card.querySelector(".track-main");
            if(main&&!main.querySelector(".rmx-cover"))main.prepend(coverMarkup(t));
        });
    }
    const trackObserver=new MutationObserver(()=>{enhanceTrackCards();updateDashboard();});
    if($("tracksContainer"))trackObserver.observe($("tracksContainer"),{childList:true,subtree:true});
    setTimeout(enhanceTrackCards,800);

    // Play-count and listening-time tracking.
    let countedTrackId=null, lastTick=0, fadeInPending=false;
    audio.addEventListener("playing",()=>{
        if (fadeInPending) {
            fadeInPending=false;
            const target=Math.max(0,Math.min(1,Number(appSettings.volume)/100));
            const start=Date.now(), duration=1200;
            const fadeIn=setInterval(()=>{
                const p=Math.min(1,(Date.now()-start)/duration);
                audio.volume=target*p;
                if(p>=1)clearInterval(fadeIn);
            },50);
        }
        const t=currentTrack();if(!t)return;
        if(countedTrackId!==t.id){
            const m=metaFor(t.id);m.plays=(m.plays||0)+1;m.lastPlayed=Date.now();
            countedTrackId=t.id;featureData.history.unshift({id:t.id,at:Date.now()});
            featureData.history=featureData.history.slice(0,200);saveFeatureData();updateDashboard();
        }
        lastTick=Date.now();
        if(audioCtx)audioCtx.resume().catch(()=>{});
    });
    audio.addEventListener("pause",()=>{lastTick=0;});
    audio.addEventListener("timeupdate",()=>{
        if(audio.paused)return;
        if(lastTick&&Date.now()-lastTick>=9000){
            featureData.totalSeconds+=Math.round((Date.now()-lastTick)/1000);
            lastTick=Date.now();saveFeatureData();updateDashboard();
        }
        const lyricsLine=$("rmx-lyrics-line");
        if(lyricsLine&&modal.classList.contains("open"))renderLyrics(currentTrack());
        if(featureData.crossfade&&audio.duration&&audio.duration-audio.currentTime<=5&&!audio.__rmxFading){
            audio.__rmxFading=true;
            userManuallyPaused=true; // suppress the original ended handler; this is an automatic transition
            const originalVolume=audio.volume, start=Date.now(), duration=Math.max(500,(audio.duration-audio.currentTime)*1000);
            const fade=setInterval(()=>{
                const p=Math.min(1,(Date.now()-start)/duration);
                audio.volume=originalVolume*(1-p);
                if(p>=1){
                    clearInterval(fade);audio.__rmxFading=false;
                    audio.volume=originalVolume;
                    advanceToNextTrack();
                }
            },100);
        }
    });
    audio.addEventListener("ended",()=>{countedTrackId=null;});

    // Improved lock-screen metadata; availability depends on browser/OS support.
    const oldMediaUpdate=updateMediaSession;
    updateMediaSession=function(track){
        oldMediaUpdate(track);
        if(!("mediaSession" in navigator)||!track)return;
        try{
            const m=metaFor(track.id), artwork=m.art?[{src:m.art,sizes:"256x256",type:"image/jpeg"}]:[];
            navigator.mediaSession.metadata=new MediaMetadata({title:track.title,artist:track.director,album:"Rishi Music",artwork});
        }catch(e){console.warn("Lock-screen artwork unavailable:",e);}
    };

    // Voice search uses browser speech recognition only when available.
    if(searchInput && !document.getElementById("rmx-voice-search")){
        const voice=document.createElement("button");voice.id="rmx-voice-search";voice.className="rmx-btn";voice.textContent="🎙 Voice";
        searchInput.insertAdjacentElement("afterend",voice);
        voice.onclick=()=>{
            const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
            if(!SR)return alert("Voice search is not supported by this browser. Try Chrome.");
            const rec=new SR();rec.lang="en-IN";rec.interimResults=false;rec.maxAlternatives=1;
            rec.onresult=e=>{searchInput.value=e.results[0][0].transcript;searchInput.dispatchEvent(new Event("input",{bubbles:true}));};
            rec.onerror=()=>alert("Voice search could not start. Check microphone permission.");
            rec.start();
        };
    }

    // Dynamic theme presets.
    function applyFeatureTheme(name){
        const presets={blue:"#1d72fe",purple:"#8b5cf6",cyan:"#06b6d4",green:"#16a34a",pink:"#ec4899",orange:"#f97316"};
        const color=presets[name];if(!color)return;
        document.documentElement.style.setProperty("--accent",color);
        const hex=color.replace("#",""),n=parseInt(hex,16);
        document.documentElement.style.setProperty("--accent-rgb",`${n>>16},${(n>>8)&255},${n&255}`);
        featureData.theme=name;saveFeatureData();
    }
    const themeButton=document.createElement("button");themeButton.className="rmx-btn";themeButton.textContent="Theme";
    $("rmx-tools").append(themeButton);
    themeButton.onclick=()=>openModal("Dynamic Themes",`<p class="rmx-muted">Choose an accent colour for the app.</p><div class="rmx-actions">${["blue","purple","cyan","green","pink","orange"].map(n=>`<button class="rmx-btn" data-theme="${n}">${n[0].toUpperCase()+n.slice(1)}</button>`).join("")}<input type="color" id="rmx-custom-theme" value="#1d72fe"></div>`);
    themeButton.addEventListener("click",()=>{
        modalContent.querySelectorAll("[data-theme]").forEach(b=>b.onclick=()=>{applyFeatureTheme(b.dataset.theme);});
        $("rmx-custom-theme").oninput=e=>{
            const color=e.target.value;document.documentElement.style.setProperty("--accent",color);
            const n=parseInt(color.slice(1),16);document.documentElement.style.setProperty("--accent-rgb",`${n>>16},${(n>>8)&255},${n&255}`);
        };
    });

    // Mini-player is a compact mode for the existing bottom dock.
    $("rmx-mini-toggle").onclick=()=>{
        document.body.classList.toggle("rmx-mini");
        $("rmx-mini-toggle").textContent=document.body.classList.contains("rmx-mini")?"Expand Player":"Mini Player";
    };

    $("rmx-tools").addEventListener("click",e=>{
        const key=e.target.closest("[data-open]")?.dataset.open;if(!key)return;
        ({player:showPlayer,queue:showQueue,playlists:showPlaylists,folders:showFolders,audio:showAudioSettings,backup:showBackup,stats:showStats})[key]?.();
    });

    // Repaint the cover and stats when a new track is loaded.
    const oldLoadTrack=loadTrackSource;
    loadTrackSource=async function(index){
        const result=await oldLoadTrack(index);
        if(result){
            if(featureData.crossfade){audio.volume=0;fadeInPending=true;}
            updateDashboard();
            if(modal.classList.contains("open")&&modalTitle.textContent.startsWith("Player"))showPlayer();
        }
        return result;
    };

    // Preserve the current theme selection after startup.
    if(featureData.theme)applyFeatureTheme(featureData.theme);
    updateDashboard();
    setInterval(updateDashboard,15000);
})();




