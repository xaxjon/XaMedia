/* Settings tile: PIN pad gate + setup screen. */
(function () {
    'use strict';

    var pinOverlay = document.getElementById('pin-overlay');
    var settingsOverlay = document.getElementById('settings-overlay');

    var sessionPin = null;   // kept in memory only; re-asked after page reload

    function el(tag, className, text) {
        var e = document.createElement(tag);
        if (className) e.className = className;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    /* ---------- PIN pad ---------- */

    // title: heading text; onOk(pin): called with the entered PIN.
    function openPinPad(title, onOk) {
        pinOverlay.innerHTML = '';
        pinOverlay.hidden = false;

        var panel = el('div', 'pin-panel');
        panel.appendChild(el('div', 'pin-title', title));

        var dots = el('div', 'pin-dots');
        panel.appendChild(dots);

        var entered = '';

        function renderDots() {
            dots.innerHTML = '';
            for (var i = 0; i < entered.length; i++) {
                dots.appendChild(el('span', 'pin-dot'));
            }
        }

        function shake() {
            panel.classList.remove('pin-error');
            void panel.offsetWidth;
            panel.classList.add('pin-error');
        }

        var pad = el('div', 'pin-pad');
        for (var d = 1; d <= 9; d++) {
            (function (digit) {
                var b = el('button', 'pin-key', String(digit));
                b.type = 'button';
                b.addEventListener('click', function () {
                    if (entered.length < 12) {
                        entered += digit;
                        renderDots();
                    }
                });
                pad.appendChild(b);
            })(d);
        }
        var clearBtn = el('button', 'pin-key pin-key-alt', 'Clear');
        clearBtn.type = 'button';
        clearBtn.addEventListener('click', function () {
            entered = '';
            renderDots();
        });
        pad.appendChild(clearBtn);

        var zeroBtn = el('button', 'pin-key', '0');
        zeroBtn.type = 'button';
        zeroBtn.addEventListener('click', function () {
            if (entered.length < 12) {
                entered += '0';
                renderDots();
            }
        });
        pad.appendChild(zeroBtn);

        var enterBtn = el('button', 'pin-key pin-key-go', 'Enter');
        enterBtn.type = 'button';
        enterBtn.addEventListener('click', function () {
            if (entered.length < 4) {
                shake();
                return;
            }
            var pin = entered;
            entered = '';
            renderDots();
            onOk(pin, shake);
        });
        pad.appendChild(enterBtn);

        panel.appendChild(pad);

        var cancelBtn = el('button', 'pin-cancel', 'Cancel');
        cancelBtn.type = 'button';
        cancelBtn.addEventListener('click', function () { pinOverlay.hidden = true; });
        panel.appendChild(cancelBtn);

        pinOverlay.appendChild(panel);
        renderDots();
    }

    pinOverlay.addEventListener('click', function (e) {
        if (e.target === pinOverlay) pinOverlay.hidden = true;
    });

    // Verify a PIN by posting an empty change set; the API answers 403 on a bad PIN.
    function verifyPin(pin, onFail) {
        fetch('api/settings.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: pin, changes: {} })
        }).then(function (r) {
            if (r.status === 403) {
                onFail();
                return;
            }
            if (!r.ok) { onFail(); return; }
            sessionPin = pin;
            pinOverlay.hidden = true;
            openSettings();
        }).catch(onFail);
    }

    /* ---------- settings screen ---------- */

    var settings = null;

    function postChanges(changes) {
        return fetch('api/settings.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: sessionPin, changes: changes })
        }).then(function (r) {
            if (r.status === 403) throw new Error('bad pin');
            if (!r.ok) throw new Error('save failed');
            return r.json().catch(function () { return {}; });
        });
    }

    function section(titleText) {
        var sec = el('section', 'set-section');
        sec.appendChild(el('h3', 'set-heading', titleText));
        return sec;
    }

    function saveButton(onClick) {
        var b = el('button', 'set-save', 'Save');
        b.type = 'button';
        b.addEventListener('click', function () {
            b.disabled = true;
            b.textContent = 'Saving…';
            onClick()
                .then(function () {
                    b.textContent = 'Saved ✓';
                    setTimeout(function () { b.disabled = false; b.textContent = 'Save'; }, 1200);
                })
                .catch(function () {
                    b.textContent = 'Error — retry';
                    setTimeout(function () { b.disabled = false; b.textContent = 'Save'; }, 1500);
                });
        });
        return b;
    }

    function textInput(value, placeholder) {
        var i = el('input', 'set-input');
        i.type = 'text';
        i.value = value || '';
        if (placeholder) i.placeholder = placeholder;
        return i;
    }

    function numberInput(value) {
        var i = el('input', 'set-input set-input-num');
        i.type = 'number';
        i.min = '1';
        i.value = value;
        return i;
    }

    /* ----- location section ----- */

    function buildLocation(root) {
        var sec = section('Location');
        sec.appendChild(el('div', 'set-current',
            'Current: ' + ((settings.location && settings.location.label) || 'not set')));

        var row = el('div', 'set-row');
        var input = textInput('', 'City name');
        var searchBtn = el('button', 'set-btn', 'Search');
        searchBtn.type = 'button';
        row.appendChild(input);
        row.appendChild(searchBtn);
        sec.appendChild(row);

        var results = el('div', 'set-results');
        sec.appendChild(results);

        var picked = null;
        var saveBtn = saveButton(function () {
            return postChanges({ location: picked }).then(function () {
                settings.location = picked;
                sec.querySelector('.set-current').textContent = 'Current: ' + picked.label;
            });
        });
        saveBtn.disabled = true;
        sec.appendChild(saveBtn);

        searchBtn.addEventListener('click', function () {
            var q = input.value.trim();
            if (!q) return;
            results.innerHTML = '';
            results.appendChild(el('div', 'set-hint', 'Searching…'));
            fetch('api/geocode.php?q=' + encodeURIComponent(q))
                .then(function (r) { return r.json(); })
                .then(function (list) {
                    results.innerHTML = '';
                    if (!Array.isArray(list) || !list.length) {
                        results.appendChild(el('div', 'set-hint', 'No matches.'));
                        return;
                    }
                    list.forEach(function (place) {
                        var label = place.name +
                            (place.admin1 ? ', ' + place.admin1 : '') +
                            (place.country ? ', ' + place.country : '');
                        var b = el('button', 'set-result', label);
                        b.type = 'button';
                        b.addEventListener('click', function () {
                            results.querySelectorAll('.set-result').forEach(function (x) {
                                x.classList.remove('selected');
                            });
                            b.classList.add('selected');
                            picked = {
                                lat: place.lat,
                                lon: place.lon,
                                label: place.name + (place.country ? ', ' + place.country : '')
                            };
                            saveBtn.disabled = false;
                        });
                        results.appendChild(b);
                    });
                })
                .catch(function () {
                    results.innerHTML = '';
                    results.appendChild(el('div', 'set-hint', 'Search failed.'));
                });
        });

        root.appendChild(sec);
    }

    /* ----- radio stations section ----- */

    var stationsDraft = [];

    function buildStations(root) {
        var sec = section('Radio Stations');
        var list = el('div', 'set-station-list');
        sec.appendChild(list);

        stationsDraft = (settings.stations || []).map(function (s) {
            return { name: s.name, url: s.url };
        });

        function renderList() {
            list.innerHTML = '';
            if (!stationsDraft.length) {
                list.appendChild(el('div', 'set-hint', 'No stations.'));
            }
            stationsDraft.forEach(function (st, i) {
                var row = el('div', 'set-station-row');
                row.appendChild(el('span', 'set-station-name', st.name));
                var rm = el('button', 'set-remove', '✕');
                rm.type = 'button';
                rm.setAttribute('aria-label', 'Remove ' + st.name);
                rm.addEventListener('click', function () {
                    stationsDraft.splice(i, 1);
                    renderList();
                });
                row.appendChild(rm);
                list.appendChild(row);
            });
        }
        renderList();

        var row = el('div', 'set-row');
        var nameIn = textInput('', 'Station name');
        var urlIn = textInput('', 'Stream URL');
        var addBtn = el('button', 'set-btn', 'Add');
        addBtn.type = 'button';
        addBtn.addEventListener('click', function () {
            var name = nameIn.value.trim(), url = urlIn.value.trim();
            if (!name || !url) return;
            stationsDraft.push({ name: name, url: url });
            nameIn.value = '';
            urlIn.value = '';
            renderList();
        });
        row.appendChild(nameIn);
        row.appendChild(urlIn);
        row.appendChild(addBtn);
        sec.appendChild(row);

        sec.appendChild(saveButton(function () {
            return postChanges({ stations: stationsDraft }).then(function () {
                settings.stations = stationsDraft;
                window.APP_CONFIG.stations = stationsDraft;
            });
        }));

        root.appendChild(sec);
    }

    /* ----- slideshow section ----- */

    function buildSlideshow(root) {
        var sec = section('Slideshow');
        var ss = settings.slideshow || {};

        var row1 = el('div', 'set-row');
        row1.appendChild(el('label', 'set-label', 'Seconds per photo'));
        var intervalIn = numberInput(ss.interval || 20);
        row1.appendChild(intervalIn);
        sec.appendChild(row1);

        var row2 = el('div', 'set-row');
        row2.appendChild(el('label', 'set-label', 'Idle timeout (s)'));
        var idleIn = numberInput(ss.idle_timeout || 120);
        row2.appendChild(idleIn);
        sec.appendChild(row2);

        sec.appendChild(saveButton(function () {
            var changes = {
                interval: Number(intervalIn.value) || ss.interval,
                fade: ss.fade,
                idle_timeout: Number(idleIn.value) || ss.idle_timeout
            };
            return postChanges({ slideshow: changes }).then(function () {
                settings.slideshow = changes;
                window.APP_CONFIG.slideshow = changes;
            });
        }));

        root.appendChild(sec);
    }

    /* ----- photos section ----- */

    function buildPhotos(root) {
        var sec = section('Photos');
        sec.appendChild(el('div', 'set-current',
            (settings.photo_count !== undefined ? settings.photo_count : '?') + ' photos in the library.'));
        sec.appendChild(el('p', 'set-hint',
            'To import photos, export your library with Google Takeout (takeout.google.com, ' +
            'select Google Photos only), download the zip files to this machine, then run ' +
            'bin/import-takeout.sh <zip> from a terminal. New photos join the slideshow ' +
            'automatically.'));
        root.appendChild(sec);
    }

    /* ----- UMS section ----- */

    function buildUms(root) {
        var sec = section('UMS (Universal Media Server)');
        var row = el('div', 'set-row');
        var input = textInput(settings.ums_url || '', 'http://host:9001');
        row.appendChild(input);
        sec.appendChild(row);
        sec.appendChild(saveButton(function () {
            var url = input.value.trim();
            return postChanges({ ums_url: url }).then(function () {
                settings.ums_url = url;
                window.APP_CONFIG.ums_url = url;
            });
        }));
        root.appendChild(sec);
    }

    /* ----- PIN change section ----- */

    function buildPin(root) {
        var sec = section('Change PIN');
        var status = el('div', 'set-hint', '');
        var btn = el('button', 'set-btn', 'Set new PIN');
        btn.type = 'button';
        btn.addEventListener('click', function () {
            status.textContent = '';
            openPinPad('Enter new PIN', function (first, shake) {
                openPinPad('Repeat new PIN', function (second, shake2) {
                    if (first !== second) {
                        pinOverlay.hidden = true;
                        status.textContent = 'PINs did not match — not changed.';
                        return;
                    }
                    postChanges({ new_pin: second })
                        .then(function () {
                            sessionPin = second;
                            pinOverlay.hidden = true;
                            status.textContent = 'PIN changed.';
                        })
                        .catch(function () {
                            pinOverlay.hidden = true;
                            status.textContent = 'Could not change PIN.';
                        });
                });
            });
        });
        sec.appendChild(btn);
        sec.appendChild(status);
        root.appendChild(sec);
    }

    /* ----- assemble ----- */

    function openSettings() {
        settingsOverlay.innerHTML = '';
        settingsOverlay.hidden = false;

        var panel = el('div', 'settings-panel');
        var head = el('div', 'settings-head');
        head.appendChild(el('span', 'settings-title', 'Settings'));
        var closeBtn = el('button', 'settings-close', '×');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.addEventListener('click', function () { settingsOverlay.hidden = true; });
        head.appendChild(closeBtn);
        panel.appendChild(head);

        var body = el('div', 'settings-body');
        body.appendChild(el('div', 'set-hint', 'Loading…'));
        panel.appendChild(body);
        settingsOverlay.appendChild(panel);

        fetch('api/settings.php')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                settings = data;
                body.innerHTML = '';
                buildLocation(body);
                buildStations(body);
                buildSlideshow(body);
                buildPhotos(body);
                buildUms(body);
                buildPin(body);
            })
            .catch(function () {
                body.innerHTML = '';
                body.appendChild(el('div', 'set-hint', 'Could not load settings.'));
            });
    }

    settingsOverlay.addEventListener('click', function (e) {
        if (e.target === settingsOverlay) settingsOverlay.hidden = true;
    });

    /* ---------- tile ---------- */

    document.getElementById('tile-settings').addEventListener('click', function () {
        if (sessionPin) {
            openSettings();
        } else {
            openPinPad('Enter PIN', verifyPin);
        }
    });
})();
