// --- НАСТРОЙКИ ЗУМА И МАСШТАБА ---
const MAP_CONFIG = { minZoom: 0, maxZoom: 8, defaultZoom: 2 }; 
const MAX_NATIVE_ZOOM = 8; // Уровень папок от vips
const TILE_FACTOR = 256;    // Магическое число: 2 в степени MAX_NATIVE_ZOOM (2^5 = 32)
// Расширяем базовый класс Leaflet, чтобы он всегда грузил тайлы "с запасом" за пределами экрана
const originalGetBounds = L.GridLayer.prototype._getTiledPixelBounds;
L.GridLayer.include({
    _getTiledPixelBounds: function (center) {
        const bounds = originalGetBounds.call(this, center);
        const tileSize = this.getTileSize();
        const buffer = 1; // Загружать на 1 тайл (256px) больше во все стороны

        bounds.min.x -= tileSize.x * buffer;
        bounds.min.y -= tileSize.y * buffer;
        bounds.max.x += tileSize.x * buffer;
        bounds.max.y += tileSize.y * buffer;
        
        return bounds;
    }
});

const map = L.map('map', {
    crs: L.CRS.Simple,
    zoomControl: false,
    minZoom: MAP_CONFIG.minZoom,
    maxZoom: MAP_CONFIG.maxZoom,
    zoomSnap: 1, 
    attributionControl: false,
    
    // --- ИЗМЕНЕНИЯ ЗДЕСЬ ---
    fadeAnimation: false, // Отключаем эффект плавного появления тайлов
    zoomAnimation: true   // Убеждаемся, что анимация зума включена (она делает зум плавным)
});

let graph = createGraph();
let pathFinder = null;
let allCabinets =[];
let fullRoute = null;
let destinationName = ""; 
let transitions = {};
let currentFloor = "1";
let floorConfigs = {};
let floorJsonCache = {}; 
let currentImageLayer = null;
let currentRouteLayer = null;
let markersLayer = L.layerGroup().addTo(map);

function getProp(obj, name) {
    if (!obj.properties) return null;
    if (Array.isArray(obj.properties)) {
        const p = obj.properties.find(p => p.name.toLowerCase() === name.toLowerCase());
        return p ? p.value : null;
    }
    return obj.properties[name] || null;
}

function findLayer(layers, keyword) {
    for (let layer of layers) {
        if (layer.name && layer.name.toLowerCase().includes(keyword.toLowerCase())) return layer;
        if (layer.layers) {
            const found = findLayer(layer.layers, keyword);
            if (found) return found;
        }
    }
    return null;
}

async function initNavigation() {
    await loadFloorData(currentFloor);
    switchFloor(currentFloor, false); 

    const floors = ["1", "2", "3", "4"];
    for (let f of floors) {
        if (f !== currentFloor) {
            try { await loadFloorData(f); } catch (e) { }
        }
    }

    for (let id in transitions) {
        let pts = transitions[id];
        if (pts.length > 1) {
            for (let i = 0; i < pts.length; i++) {
                for (let j = i + 1; j < pts.length; j++) {
                    graph.addLink(pts[i].nodeId, pts[j].nodeId, { weight: 10000 });
                    graph.addLink(pts[j].nodeId, pts[i].nodeId, { weight: 10000 });
                }
            }
        }
    }

    pathFinder = ngraphPath.aStar(graph, {
        distance(a, b, link) { return link.data.weight || 1; },
        heuristic(a, b) {
            const floorPenalty = a.data.floor !== b.data.floor ? 20000 : 0;
            return Math.hypot(a.data.x - b.data.x, a.data.y - b.data.y) + floorPenalty;
        }
    });

    updateDatalist();
}

async function loadFloorData(floorNum) {
    if (floorJsonCache[floorNum]) return floorJsonCache[floorNum];

    const res = await fetch(`${floorNum}.json`);
    const data = await res.json();
    
    floorJsonCache[floorNum] = data; 
    
    const lw = data.width * (data.tilewidth || 32);
    const lh = data.height * (data.tileheight || 32);
    floorConfigs[floorNum] = { lw, lh, scaleX: 1, scaleY: 1 };

    const nodesLayer = findLayer(data.layers, "nodes");
    if (nodesLayer && nodesLayer.objects) {
        nodesLayer.objects.forEach(obj => {
            if (obj.polyline) {
                let prevX = null, prevY = null, prevId = null;
                obj.polyline.forEach(pt => {
                    const curX = obj.x + pt.x;
                    const curY = obj.y + pt.y;
                    const curId = `f${floorNum}_${curX},${curY}`;
                    if (prevId) {
                        const dist = Math.hypot(curX - prevX, curY - prevY);
                        const stepSize = 15;
                        const steps = Math.max(1, Math.floor(dist / stepSize));
                        let tempPrevId = prevId;
                        let lastX = prevX, lastY = prevY;
                        for (let i = 1; i <= steps; i++) {
                            const ix = prevX + (curX - prevX) * (i / steps);
                            const iy = prevY + (curY - prevY) * (i / steps);
                            const iId = i === steps ? curId : `f${floorNum}_${ix.toFixed(2)},${iy.toFixed(2)}`;
                            const w = Math.hypot(ix - lastX, iy - lastY);
                            graph.addNode(iId, { x: ix, y: iy, floor: floorNum });
                            graph.addLink(tempPrevId, iId, { weight: w });
                            graph.addLink(iId, tempPrevId, { weight: w });
                            tempPrevId = iId; lastX = ix; lastY = iy;
                        }
                    } else { graph.addNode(curId, { x: curX, y: curY, floor: floorNum }); }
                    prevX = curX; prevY = curY; prevId = curId;
                });
            }
        });
    }

    data.layers.forEach(layer => {
        if (layer.objects) {
            layer.objects.forEach(obj => {
                let cabinet = getProp(obj, "cabinet");
                let transId = getProp(obj, "transition_id");
                if (cabinet || transId) {
                    const nid = findNearestNode(obj.x, obj.y, floorNum);
                    if (!nid) return;
                    const name = cabinet || transId;
                    allCabinets.push({
                        name: String(name).trim(),
                        floor: floorNum,
                        rx: obj.x, ry: obj.y,
                        nodeId: nid
                    });
                    if (transId) {
                        if (!transitions[transId]) transitions[transId] = [];
                        transitions[transId].push({ nodeId: nid, floor: floorNum });
                    }
                }
            });
        }
    });
    
    return data; 
}

function findNearestNode(x, y, floor) {
    let nid = null, minDist = Infinity;
    graph.forEachNode(n => {
        if (n.data.floor === floor) {
            let d = Math.hypot(n.data.x - x, n.data.y - y);
            if (d < minDist) { minDist = d; nid = n.id; }
        }
    });
    return nid;
}

async function switchFloor(floorNum, animate = true) {
    currentFloor = floorNum;
    updateDatalist(); 
    
    try {
        const data = await loadFloorData(floorNum);
        const conf = floorConfigs[floorNum];

        const originalWidth = 44800; 
        const originalHeight = 49600;

        conf.pw = originalWidth; 
        conf.ph = originalHeight;
        conf.scaleX = originalWidth / conf.lw;
        conf.scaleY = originalHeight / conf.lh;

        if (currentImageLayer) {
            map.removeLayer(currentImageLayer);
        }

        // ВЕРНУЛИ ГРАНИЦЫ: Теперь Leaflet не будет искать кусочки x: -1
        const bounds = [[0, 0], [-(originalHeight / TILE_FACTOR), (originalWidth / TILE_FACTOR)]];

        // ВЕРНУЛИ .webp: Нарезанные кусочки лежат именно в этом формате!
currentImageLayer = L.tileLayer(`tiles/${floorNum}/{z}/{y}/{x}.png`, {
    minZoom: MAP_CONFIG.minZoom,
    maxZoom: MAP_CONFIG.maxZoom, 
    maxNativeZoom: MAX_NATIVE_ZOOM,
    tileSize: 256,
    noWrap: true,
    bounds: bounds,
    
    updateWhenZooming: false, 
    updateWhenIdle: false,    // <--- ДОБАВИТЬ: Грузить тайлы СРАЗУ при движении, не дожидаясь остановки пальца
    keepBuffer: 8,            // <--- ИЗМЕНИТЬ: Хранить в памяти больше старых тайлов (убирает мерцание при зуме)
    
    errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' 
}).addTo(map);
        map.setMaxBounds(bounds);
        markersLayer.clearLayers();
        
        loadLabels(data, floorNum);
        
        if (fullRoute) {
            drawPathOnCurrentFloor();
        } else {
            const center =[-(originalHeight / 2) / TILE_FACTOR, (originalWidth / 2) / TILE_FACTOR];
            if (animate) {
                map.flyTo(center, MAP_CONFIG.defaultZoom, { duration: 1.5 });
            } else {
                map.setView(center, MAP_CONFIG.defaultZoom);
            }
        }

    } catch (error) {
        console.error("Ошибка:", error);
    }
}

window.switchFloorFromPopup = function(floor) {
    const btn = document.querySelector(`.floor-btn[data-floor="${floor}"]`);
    if (btn) btn.click();
};

function drawPathOnCurrentFloor() {
    if (currentRouteLayer) map.removeLayer(currentRouteLayer);
    const conf = floorConfigs[currentFloor];
    
    // Переводим координаты JSON в координаты Leaflet (делим на 32, Y уходит в минус)
    const pts = fullRoute
        .filter(n => n.data.floor === currentFloor)
        .map(n =>[
            -(n.data.y * conf.scaleY) / TILE_FACTOR, 
             (n.data.x * conf.scaleX) / TILE_FACTOR
        ]);

    if (pts.length > 1) {
        currentRouteLayer = L.polyline(pts, {
            color: '#2563eb', weight: 5, opacity: 0.8, dashArray: '10, 10', className: 'running-route'
        }).addTo(map);

        const startNode = fullRoute[fullRoute.length - 1];
        const endNode = fullRoute[0]; 
        
        if (startNode.data.floor === currentFloor) {
            L.circleMarker([
                -(startNode.data.y * conf.scaleY) / TILE_FACTOR, 
                 (startNode.data.x * conf.scaleX) / TILE_FACTOR
            ], { radius: 6, color: 'green', fillOpacity: 1 }).addTo(markersLayer).bindPopup("Начало");
        }
        
        if (endNode.data.floor === currentFloor) {
            L.circleMarker([
                -(endNode.data.y * conf.scaleY) / TILE_FACTOR, 
                 (endNode.data.x * conf.scaleX) / TILE_FACTOR
            ], { radius: 6, color: 'red', fillOpacity: 1 })
            .addTo(markersLayer)
            .bindPopup(destinationName)
            .openPopup();
        }
        map.fitBounds(currentRouteLayer.getBounds(), { padding:[50, 50] });
    }

    if (fullRoute) {
        const forwardRoute = [...fullRoute].reverse();
        for (let i = 0; i < forwardRoute.length - 1; i++) {
            let currNode = forwardRoute[i];
            let nextNode = forwardRoute[i+1];

            if (currNode.data.floor === currentFloor && nextNode.data.floor !== currentFloor) {
                let cFloorNum = parseInt(currentFloor);
                let nFloorNum = parseInt(nextNode.data.floor);
                let action = nFloorNum > cFloorNum ? "Поднимитесь" : "Спуститесь";
                let text = `${action} на ${nFloorNum} этаж по лестнице`;
                
                let lat = -(currNode.data.y * conf.scaleY) / TILE_FACTOR;
                let lng =  (currNode.data.x * conf.scaleX) / TILE_FACTOR;

                let markerHtml = `
                    <div style="text-align:center; cursor:pointer; padding: 4px;" onclick="window.switchFloorFromPopup('${nextNode.data.floor}')">
                        <span style="font-size: 13px; font-weight: bold; color: #1e2937;">${text}</span><br>
                        <span style="color:#2563eb; text-decoration:underline; font-size: 11px;">Перейти на ${nextNode.data.floor} этаж</span>
                    </div>
                `;

                L.circleMarker([lat, lng], { radius: 7, color: '#f59e0b', fillOpacity: 1, weight: 2 })
                    .addTo(markersLayer)
                    .bindPopup(markerHtml, { closeButton: false, autoClose: false })
                    .openPopup();
            }
        }
    }
}

function loadLabels(data, floorNum) {
    const labelsLayer = findLayer(data.layers, "Labels");
    if (!labelsLayer || !labelsLayer.objects) return;
    const conf = floorConfigs[floorNum];
    labelsLayer.objects.forEach(obj => {
        // Переводим координаты текста
        const lat = -(obj.y * conf.scaleY) / TILE_FACTOR;
        const lng =  (obj.x * conf.scaleX) / TILE_FACTOR;
        
        const icon = L.divIcon({
            className: 'map-label',
            html: `<span>${obj.name || ''}</span>`,
            iconSize: [60, 15], iconAnchor: [30, 7]
        });
        L.marker([lat, lng], { icon, interactive: false }).addTo(markersLayer);
    });
}

function updateDatalist() {
    const endList = document.getElementById('end-cabinet-list');
    const startList = document.getElementById('start-cabinet-list');
    if (!endList || !startList) return;

    const validCabinets = allCabinets.filter(c => /^\d/.test(c.name));

    const allNames =[...new Set(validCabinets.map(c => c.name))]
        .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
    endList.innerHTML = allNames.map(n => `<option value="${n}">`).join('');

    const floorCabinets = validCabinets.filter(c => String(c.floor) === String(currentFloor));
    const floorNames =[...new Set(floorCabinets.map(c => c.name))]
        .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
    startList.innerHTML = floorNames.map(n => `<option value="${n}">`).join('');
}

document.getElementById('search-btn').onclick = () => {
    const sVal = document.getElementById('start-cabinet').value.trim();
    const eVal = document.getElementById('end-cabinet').value.trim();
    const start = allCabinets.find(c => c.name === sVal);
    const end = allCabinets.find(c => c.name === eVal);

    if (start && end) {
        const path = pathFinder.find(start.nodeId, end.nodeId);
        if (path && path.length > 0) {
            fullRoute = path;
            destinationName = eVal;

            if (window.innerWidth <= 768) {
                document.getElementById('start-cabinet').blur();
                document.getElementById('end-cabinet').blur();
                setTimeout(() => {
                    document.getElementById('search-panel').style.display = 'none';
                }, 100);
            }
            if (start.floor !== currentFloor) {
                const btn = document.querySelector(`.floor-btn[data-floor="${start.floor}"]`);
                if (btn) btn.click();
            } else {
                drawPathOnCurrentFloor();
            }
        } else {
            alert("Путь не найден!");
        }
    } else {
        alert("Кабинет не найден!");
    }
};

document.getElementById('zoom-in').onclick = () => map.zoomIn();
document.getElementById('zoom-out').onclick = () => map.zoomOut();
document.getElementById('reset-view').onclick = () => switchFloor(currentFloor, true);
document.getElementById('toggle-search').onclick = () => {
    const p = document.getElementById('search-panel');
    p.style.display = (p.style.display === 'none' || p.style.display === '') ? 'flex' : 'none';
};

document.getElementById('clear-route').onclick = () => {
    fullRoute = null;
    destinationName = "";
    document.getElementById('start-cabinet').value = '';
    document.getElementById('end-cabinet').value = '';
    if (currentRouteLayer) {
        map.removeLayer(currentRouteLayer);
        currentRouteLayer = null;
    }
    switchFloor(currentFloor, false);
};

document.querySelectorAll('.floor-btn').forEach(btn => {
    btn.onclick = function() {
        const f = this.getAttribute('data-floor');
        document.querySelectorAll('.floor-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        switchFloor(f, false);
    };
});

initNavigation();
