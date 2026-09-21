/* Photo manager: thumbnail grid with purge (to .trash) and 90° rotate.
   Opened from photo mode via the gear button. */
(function () {
    'use strict';

    var overlay = document.getElementById('photos-overlay');
    var grid = document.getElementById('photos-grid');
    var status = document.getElementById('photos-status');
    var editBtn = document.getElementById('photo-edit');
    var viewer = document.getElementById('photo-view');
    var viewerImg = document.getElementById('photo-view-img');

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function photoUrl(rel) {
        return 'api/photo.php?f=' + encodeURIComponent(rel);
    }
    function thumbUrl(rel) {
        return 'api/thumb.php?f=' + encodeURIComponent(rel);
    }

    function loadGrid() {
        grid.innerHTML = '';
        selected = {};
        selectMode = false;
        updateSelUi();
        status.textContent = 'Loading…';
        fetch('api/photos.php?sort=path')
            .then(function (r) { return r.json(); })
            .then(function (list) {
                status.textContent = list.length + ' photos';
                grid.innerHTML = '';
                list.forEach(function (rel) {
                    grid.appendChild(buildCard(rel));
                });
            })
            .catch(function () {
                status.textContent = 'Could not load photos';
            });
    }

    function buildCard(rel) {
        var card = el('div', 'photo-card');
        card.dataset.rel = rel;

        var img = el('img', 'photo-thumb');
        img.loading = 'lazy';
        img.src = thumbUrl(rel);
        img.alt = '';
        img.title = rel;
        // Click the thumbnail to view the photo full-screen (lightbox
        // stays inside the manager; it does NOT jump to the slideshow).
        // In select mode, clicks toggle selection instead.
        img.addEventListener('click', function () {
            if (selectMode) {
                toggleSelect(card);
                return;
            }
            viewerImg.src = photoUrl(rel);
            viewer.hidden = false;
        });
        card.appendChild(img);

        var bar = el('div', 'photo-card-bar');

        var rot = el('button', 'photo-op photo-rotate-btn', '⟳');
        rot.type = 'button';
        rot.title = 'Rotate 90° clockwise';
        rot.addEventListener('click', function () {
            rot.disabled = true;
            fetch('api/photo-rotate.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ f: rel })
            })
                .then(function (r) { return r.json(); })
                .then(function (res) {
                    rot.disabled = false;
                    if (res.ok) {
                        // Bust caches for this image: reload thumb and let the
                        // slideshow see the rotated file (mtime changed).
                        img.src = thumbUrl(rel) + '&t=' + Date.now();
                    } else {
                        status.textContent = 'Rotate failed: ' + (res.error || '');
                    }
                })
                .catch(function () {
                    rot.disabled = false;
                    status.textContent = 'Rotate failed: no connection';
                });
        });
        bar.appendChild(rot);

        var del = el('button', 'photo-op photo-delete-btn', '✕');
        del.type = 'button';
        del.title = 'Move to trash';
        del.addEventListener('click', function () {
            if (!del.classList.contains('armed')) {
                // Two-tap confirm.
                del.classList.add('armed');
                del.textContent = 'Sure?';
                setTimeout(function () {
                    del.classList.remove('armed');
                    del.textContent = '✕';
                }, 3000);
                return;
            }
            del.disabled = true;
            var resetDel = function () {
                del.disabled = false;
                del.classList.remove('armed');
                del.textContent = '✕';
            };
            fetch('api/photo-delete.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ f: rel })
            })
                .then(function (r) { return r.json(); })
                .then(function (res) {
                    if (res.ok) {
                        card.classList.add('photo-card-deleted');
                        setTimeout(function () { card.remove(); }, 350);
                        var n = parseInt(status.textContent, 10);
                        if (!isNaN(n) && n > 0) status.textContent = (n - 1) + ' photos';
                    } else {
                        status.textContent = 'Delete failed: ' + (res.error || '');
                        resetDel();
                    }
                })
                .catch(function () {
                    status.textContent = 'Delete failed: no connection';
                    resetDel();
                });
        });
        bar.appendChild(del);

        card.appendChild(bar);
        return card;
    }

    /* ---------- multi-select + batch delete ---------- */

    var selectMode = false;
    var selected = {};   /* rel -> true */
    var selectBtn = document.getElementById('photos-select');
    var selAllBtn = document.getElementById('photos-select-all');
    var selNoneBtn = document.getElementById('photos-select-none');
    var delSelBtn = document.getElementById('photos-delete-sel');

    function selectedCount() { return Object.keys(selected).length; }

    function updateSelUi() {
        var n = selectedCount();
        selAllBtn.hidden = !selectMode;
        selNoneBtn.hidden = !selectMode;
        delSelBtn.hidden = !selectMode || n === 0;
        delSelBtn.textContent = 'Delete ' + n;
        delSelBtn.classList.remove('armed');
        delSelBtn.disabled = false;
        selectBtn.classList.toggle('active', selectMode);
        selectBtn.textContent = selectMode ? 'Done' : 'Select';
    }

    function toggleSelect(card) {
        var rel = card.dataset.rel;
        if (selected[rel]) {
            delete selected[rel];
            card.classList.remove('selected');
        } else {
            selected[rel] = true;
            card.classList.add('selected');
        }
        updateSelUi();
    }

    selectBtn.addEventListener('click', function () {
        selectMode = !selectMode;
        if (!selectMode) {
            selected = {};
            grid.querySelectorAll('.photo-card.selected').forEach(function (c) {
                c.classList.remove('selected');
            });
        }
        updateSelUi();
    });

    selAllBtn.addEventListener('click', function () {
        grid.querySelectorAll('.photo-card').forEach(function (c) {
            selected[c.dataset.rel] = true;
            c.classList.add('selected');
        });
        updateSelUi();
    });

    selNoneBtn.addEventListener('click', function () {
        selected = {};
        grid.querySelectorAll('.photo-card.selected').forEach(function (c) {
            c.classList.remove('selected');
        });
        updateSelUi();
    });

    delSelBtn.addEventListener('click', function () {
        if (!delSelBtn.classList.contains('armed')) {
            /* two-tap confirm, same convention as single-card delete */
            delSelBtn.classList.add('armed');
            delSelBtn.textContent = 'Sure? Delete ' + selectedCount();
            setTimeout(updateSelUi, 3000);
            return;
        }
        delSelBtn.disabled = true;
        var rels = Object.keys(selected);
        var i = 0;
        var failed = 0;
        function next() {
            if (i >= rels.length) {
                status.textContent = 'Deleted ' + (rels.length - failed) + ' photos'
                    + (failed ? ', ' + failed + ' failed' : '');
                selected = {};
                selectMode = false;
                updateSelUi();
                grid.querySelectorAll('.photo-card.selected').forEach(function (c) {
                    c.classList.remove('selected');
                });
                return;
            }
            var rel = rels[i++];
            var card = grid.querySelector('.photo-card[data-rel="' + CSS.escape(rel) + '"]');
            status.textContent = 'Deleting… ' + i + '/' + rels.length;
            fetch('api/photo-delete.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ f: rel })
            })
                .then(function (r) { return r.json(); })
                .then(function (res) {
                    if (res.ok && card) {
                        card.classList.add('photo-card-deleted');
                        setTimeout(function () { card.remove(); }, 300);
                    } else {
                        failed++;
                    }
                })
                .catch(function () { failed++; })
                .finally(next);
        }
        next();
    });

    /* ---------- blank-photo pre-filter ---------- */

    var findBtn = document.getElementById('photos-find-blank');
    var purgeBtn = document.getElementById('photos-purge-blank');
    var blankList = [];

    function markBlanks(flagged) {
        blankList = flagged;
        var marks = 0;
        grid.querySelectorAll('.photo-card').forEach(function (card) {
            var hit = flagged.indexOf(card.dataset.rel) >= 0;
            card.classList.toggle('blank-hit', hit);
            if (hit) marks++;
        });
        status.textContent = flagged.length + ' blank photos found';
        if (flagged.length) {
            purgeBtn.textContent = 'Purge ' + flagged.length + ' blank photos';
            purgeBtn.hidden = false;
        }
    }

    function pollScan() {
        fetch('api/photo-blanks.php')
            .then(function (r) { return r.json(); })
            .then(function (s) {
                if (!s.finished) {
                    status.textContent = 'Scanning… ' + s.done + '/' + s.total;
                    setTimeout(pollScan, 3000);
                } else {
                    markBlanks(s.flagged || []);
                }
            })
            .catch(function () { status.textContent = 'Scan failed'; });
    }

    findBtn.addEventListener('click', function () {
        findBtn.disabled = true;
        status.textContent = 'Starting scan…';
        fetch('api/photo-blanks.php', { method: 'POST' })
            .then(function () { setTimeout(pollScan, 2000); })
            .catch(function () { status.textContent = 'Could not start scan'; })
            .finally(function () { findBtn.disabled = false; });
    });

    purgeBtn.addEventListener('click', function () {
        if (!purgeBtn.classList.contains('armed')) {
            purgeBtn.classList.add('armed');
            purgeBtn.textContent = 'Sure? Purge ' + blankList.length;
            setTimeout(function () {
                purgeBtn.classList.remove('armed');
                purgeBtn.textContent = 'Purge ' + blankList.length + ' blank photos';
            }, 3000);
            return;
        }
        purgeBtn.disabled = true;
        var i = 0;
        var failed = 0;
        function next() {
            if (i >= blankList.length) {
                status.textContent = 'Purged ' + (blankList.length - failed) +
                    (failed ? ', ' + failed + ' failed' : '');
                purgeBtn.hidden = true;
                purgeBtn.disabled = false;
                purgeBtn.classList.remove('armed');
                grid.querySelectorAll('.photo-card.blank-hit').forEach(function (c) {
                    c.classList.add('photo-card-deleted');
                    setTimeout(function () { c.remove(); }, 350);
                });
                return;
            }
            var rel = blankList[i++];
            status.textContent = 'Purging… ' + i + '/' + blankList.length;
            fetch('api/photo-delete.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ f: rel })
            })
                .then(function (r) { return r.json(); })
                .then(function (res) { if (!res.ok) failed++; })
                .catch(function () { failed++; })
                .finally(next);
        }
        next();
    });

    editBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        overlay.hidden = false;
        loadGrid();
    });
    document.getElementById('photos-close').addEventListener('click', function () {
        overlay.hidden = true;
    });
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) overlay.hidden = true;
    });

    function closeViewer() {
        viewer.hidden = true;
        viewerImg.removeAttribute('src');
    }
    document.getElementById('photo-view-close').addEventListener('click', closeViewer);
    viewer.addEventListener('click', function (e) {
        if (e.target === viewer) closeViewer();
    });
})();
