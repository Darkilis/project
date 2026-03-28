// --- НАСТРОЙКИ ЗУМА ---
    const MAP_CONFIG = { minZoom: -4, maxZoom: 0.5, defaultZoom: -4 };

    const map = L.map('map', {
        crs: L.CRS.Simple,
        zoomControl: false,
        minZoom: MAP_CONFIG.minZoom,
        maxZoom: MAP_CONFIG.maxZoom,
        zoomSnap: 0.1,
        attributionControl: false,
        preferCanvas: true
    });

    let graph = createGraph();
    let pathFinder = null;
    let allCabinets = [];
    let fullRoute = null;
    let destinationName = ""; 
    let transitions = {};
    let currentFloor = "3";
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
                try { await loadFloorData(f); } catch (e) { console.warn(`Данные для этажа ${f} отсутствуют`); }
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
            const floorData = await loadFloorData(floorNum);
            
            const img = new Image();
            img.src = `${floorNum}.png`; // Убедись, что на GitHub именно .png
            
            img.onload = function() {
                const conf = floorConfigs[floorNum];
                conf.pw = this.width; conf.ph = this.height;
                conf.scaleX = this.width / conf.lw;
                conf.scaleY = this.height / conf.lh;

                if (currentImageLayer) {
                    map.removeLayer(currentImageLayer);
                    currentImageLayer = null; 
                }
                const bounds = [[0, 0], [conf.ph, conf.pw]];
                currentImageLayer = L.imageOverlay(img.src, bounds).addTo(map);
                map.setMaxBounds(bounds);
                markersLayer.clearLayers();
                
                loadLabels(floorData, floorNum);
                
                if (fullRoute) {
                    drawPathOnCurrentFloor();
                } else {
                    if (animate) {
                        map.flyTo([conf.ph/2, conf.pw/2], MAP_CONFIG.defaultZoom, { duration: 1.5 });
                    } else {
                        map.setView([conf.ph/2, conf.pw/2], MAP_CONFIG.defaultZoom);
                    }
                }
            };

            // НОВОЕ: Отлов ошибки, если картинки нет
            img.onerror = function() {
                alert(`ОШИБКА: Не удалось загрузить карту ${img.src}. Проверь имя файла и расширение на GitHub!`);
            };

        } catch (error) {
            // Отлов ошибки, если сломался или пропал JSON файл
            alert(`ОШИБКА JSON: Не удалось загрузить данные для этажа ${floorNum}.json!`);
            console.error(error);
        }
    }

    window.switchFloorFromPopup = function(floor) {
        const btn = document.querySelector(`.floor-btn[data-floor="${floor}"]`);
        if (btn) btn.click();
    };

    function drawPathOnCurrentFloor() {
        if (currentRouteLayer) map.removeLayer(currentRouteLayer);
        const conf = floorConfigs[currentFloor];
        const pts = fullRoute
            .filter(n => n.data.floor === currentFloor)
            .map(n => [conf.ph - (n.data.y * conf.scaleY), n.data.x * conf.scaleX]);

        if (pts.length > 1) {
            currentRouteLayer = L.polyline(pts, {
                color: '#2563eb', weight: 5, opacity: 0.8, dashArray: '10, 10', className: 'running-route'
            }).addTo(map);

            const startNode = fullRoute[fullRoute.length - 1];
            const endNode = fullRoute[0]; 
            if (startNode.data.floor === currentFloor) {
                L.circleMarker([conf.ph - (startNode.data.y * conf.scaleY), startNode.data.x * conf.scaleX],
                { radius: 6, color: 'green', fillOpacity: 1 }).addTo(markersLayer).bindPopup("Начало");
            }
            if (endNode.data.floor === currentFloor) {
                L.circleMarker([conf.ph - (endNode.data.y * conf.scaleY), endNode.data.x * conf.scaleX],
                { radius: 6, color: 'red', fillOpacity: 1 })
                .addTo(markersLayer)
                .bindPopup(destinationName)
                .openPopup();
            }
            map.fitBounds(currentRouteLayer.getBounds(), { padding: [50, 50] });
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
                    let lat = conf.ph - (currNode.data.y * conf.scaleY);
                    let lng = currNode.data.x * conf.scaleX;

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
            const x = obj.x * conf.scaleX;
            const y = conf.ph - (obj.y * conf.scaleY);
            const icon = L.divIcon({
                className: 'map-label',
                html: `<span>${obj.name || ''}</span>`,
                iconSize: [60, 15], iconAnchor: [30, 7]
            });
            L.marker([y, x], { icon, interactive: false }).addTo(markersLayer);
        });
    }

    function updateDatalist() {
        const endList = document.getElementById('end-cabinet-list');
        const startList = document.getElementById('start-cabinet-list');
        if (!endList || !startList) return;

        const validCabinets = allCabinets.filter(c => /^\d/.test(c.name));

        const allNames = [...new Set(validCabinets.map(c => c.name))]
            .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
        endList.innerHTML = allNames.map(n => `<option value="${n}">`).join('');

        const floorCabinets = validCabinets.filter(c => String(c.floor) === String(currentFloor));
        const floorNames = [...new Set(floorCabinets.map(c => c.name))]
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

                // --- НОВОЕ: Скрытие панели поиска и клавиатуры на телефонах ---
                if (window.innerWidth <= 768) {
                    // 1. Сначала принудительно закрываем клавиатуру
                    document.getElementById('start-cabinet').blur();
                    document.getElementById('end-cabinet').blur();
                    
                    // 2. Ждем 100 миллисекунд, пока клавиатура начнет уезжать вниз, 
                    // и только потом прячем саму панель.
                    setTimeout(() => {
                        document.getElementById('search-panel').style.display = 'none';
                    }, 100);
                }
                // --------------------------------------------------------------
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
