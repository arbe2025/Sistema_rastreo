const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const socketIo = require('socket.io');
const http = require('http');
const twilio = require('twilio');
const NodeGeocoder = require('node-geocoder'); // Agregar esta dependencia
require('dotenv').config();

const app = express();
const port = process.env.PORT || 4000;

// Crear servidor HTTP
const server = http.createServer(app);

// Configurar Socket.IO
const io = socketIo(server, {
    cors: {
        origin: 'https://sistema-rastreoarbe.vercel.app',
        methods: ['GET', 'POST'],
        credentials: true
    }
});

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
}));
app.use(express.json());
app.use(express.static('public'));

// Configuración de la base de datos MySQL
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 30000
});

// Verificar conexión inicial
db.getConnection((err, connection) => {
    if (err) {
        console.error('Error al conectar a la base de datos al iniciar:', err);
        process.exit(1);
    }
    console.log('Conexión a la base de datos establecida');
    connection.release();
});

// Configuración de Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const recipientPhoneNumber = process.env.RECIPIENT_PHONE_NUMBER;

if (!accountSid || !authToken || !twilioPhoneNumber || !recipientPhoneNumber) {
    console.error('Faltan variables de entorno de Twilio. Verifica tu archivo .env');
    process.exit(1);
}

const twilioClient = twilio(accountSid, authToken);

// Variable para controlar si se pueden enviar SMS
let canSendSMS = true;

// Objeto para rastrear el tiempo de la última alerta por dispositivo
const alertSent = {};

// Configuración de node-geocoder
const geocoderOptions = {
    provider: 'google',
    apiKey: process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyD-jiDxqTS_5ey5hr9WdaUO3AJ0Q4N_-MM', // Usa tu clave de API (asegúrate de añadirla a .env)
    formatter: null
};
const geocoder = NodeGeocoder(geocoderOptions);

// Función para verificar inactividad y enviar SMS
const checkInactivity = () => {
    console.log('Verificando inactividad...');
    const query = `
        SELECT l.device_id, MAX(l.timestamp) as last_update, l.lat, l.lng, l.placeName, d.name 
        FROM locations l
        LEFT JOIN devices d ON l.device_id = d.device_id
        GROUP BY l.device_id
    `;
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error al verificar inactividad:', err);
            return;
        }
        if (!results || results.length === 0) {
            console.log('No hay ubicaciones registradas para verificar inactividad');
            return;
        }

        const now = new Date();
        results.forEach(location => {
            const deviceId = location.device_id;
            const lastUpdate = new Date(location.last_update);
            const diffInMinutes = (now - lastUpdate) / (1000 * 60);
            console.log(`Dispositivo ${deviceId}: ${diffInMinutes.toFixed(2)} minutos desde última actualización`);

            // Detectar inactividad después de 7 minutos (cambiado de 2 minutos)
            if (diffInMinutes >= 7) {
                const driverName = location.name || `Chofer ${deviceId}`;
                const placeName = location.placeName || `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`;
                const lastUpdateLocal = lastUpdate.toLocaleString('es-MX', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
                const message = `${driverName} (ID: ${deviceId}) lleva más de 7 minutos detenido en ${placeName}. Última actualización: ${lastUpdateLocal}`;
                console.log('Detectada inactividad:', message);

                // Enviar alerta al dashboard
                io.emit('adminAlert', { deviceId, message });

                // Enviar SMS solo si no se ha enviado antes para este período de inactividad y si está permitido
                if (!alertSent[deviceId] && canSendSMS) {
                    console.log(`Enviando SMS para ${deviceId}`);
                    // twilioClient.messages
                    //     .create({
                    //         body: message,
                    //         from: twilioPhoneNumber,
                    //         to: recipientPhoneNumber
                    //     })
                    //     .then(msg => {
                    //         console.log(`SMS enviado con SID: ${msg.sid}`);
                    //         alertSent[deviceId] = true; // Marcar como enviado
                    //     })
                    //     .catch(error => {
                    //         console.error('Error al enviar SMS:', error.message, error.code);
                    //         if (error.message.includes('exceeded the null daily messages limit')) {
                    //             canSendSMS = false; // Desactivar envío de SMS si se excede el límite
                    //             console.log('Límite diario de SMS alcanzado. Desactivando envío de SMS.');
                    //         }
                    //     });
                    console.log(`SMS simulado para ${deviceId}: ${message}`); // Simular envío
                } else if (!canSendSMS) {
                    console.log(`No se puede enviar SMS para ${deviceId}: límite diario alcanzado`);
                } else {
                    console.log(`SMS ya enviado previamente para ${deviceId}`);
                }
            } else {
                // Reiniciar la bandera si el dispositivo se mueve (menos de 7 minutos)
                if (alertSent[deviceId]) {
                    console.log(`Reiniciando alerta para ${deviceId} - ahora activo`);
                    alertSent[deviceId] = false;
                }
            }
        });
    });
};

// Verificar inactividad cada 15 segundos
setInterval(checkInactivity, 15000);

// Configuración de Socket.IO
io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);
    socket.on('registerDevice', (deviceId) => {
        socket.deviceId = deviceId;
        console.log(`Dispositivo registrado: ${deviceId}`);
        socket.join(deviceId);
    });

    socket.on('startTrip', (deviceId) => {
        console.log(`Viaje iniciado para ${deviceId}`);
        io.emit('tripStarted', deviceId);
    });

    socket.on('endTrip', (deviceId) => {
        console.log(`Viaje finalizado para ${deviceId}`);
        io.emit('tripEnded', deviceId);
    });

    socket.on('inactivityAlert', (alert) => {
        console.log('Alerta de inactividad recibida:', alert);
        io.emit('adminAlert', alert);
        io.to(alert.deviceId).emit('driverAlert', 'Por favor, continúe su ruta. Ha estado inactivo por más de 7 minutos.');
    });

    socket.on('disconnect', () => {
        console.log('Cliente desconectado:', socket.id);
    });
});

// Rutas de la API
app.post('/api/location', async (req, res) => {
    const { deviceId, lat, lng, speed } = req.body;
    console.log('Datos recibidos:', { deviceId, lat, lng, speed });

    if (!deviceId || lat === undefined || lng === undefined || isNaN(lat) || isNaN(lng)) {
        console.log('Datos inválidos:', { deviceId, lat, lng, speed });
        return res.status(400).json({ error: 'Datos incompletos o inválidos', received: { deviceId, lat, lng, speed } });
    }

    let placeName = `${lat.toFixed(6)}, ${lng.toFixed(6)}`; // Fallback

    try {
        // Realizar geocodificación inversa
        const geoResponse = await geocoder.reverse({ lat, lon: lng });
        if (geoResponse && geoResponse.length > 0) {
            placeName = geoResponse[0].formattedAddress || placeName;
            console.log(`Geocodificación exitosa: ${placeName}`);
        } else {
            console.log('No se obtuvo respuesta válida de geocodificación');
        }
    } catch (geoError) {
        console.error('Error en geocodificación:', geoError);
    }

    const query = 'INSERT INTO locations (device_id, lat, lng, speed, placeName, timestamp) VALUES (?, ?, ?, ?, ?, NOW())';
    db.query(query, [deviceId, lat, lng, speed || 0, placeName], (err, result) => {
        if (err) {
            console.error('Error al insertar ubicación:', err.code, err.sqlMessage, { deviceId, lat, lng, speed });
            return res.status(500).json({ error: 'Error interno del servidor', code: err.code, message: err.sqlMessage });
        }
        io.emit('updateLocation', { device_id: deviceId, lat, lng, speed: speed || 0 });
        res.json({ status: 'success', id: result.insertId });
    });
});

app.get('/api/devices', (req, res) => {
    const query = 'SELECT device_id, name FROM devices';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error al obtener dispositivos:', err);
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});

app.get('/api/locations', (req, res) => {
    const deviceId = req.query.deviceId;
    let query = 'SELECT device_id, lat, lng, speed, placeName, timestamp FROM locations ORDER BY timestamp DESC LIMIT 100';
    let params = [];
    
    if (deviceId) {
        query = 'SELECT device_id, lat, lng, speed, placeName, timestamp FROM locations WHERE device_id = ? ORDER BY timestamp DESC LIMIT 100';
        params = [deviceId];
    }

    db.query(query, params, (err, results) => {
        if (err) {
            console.error('Error al obtener ubicaciones:', err);
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});

app.post('/api/assignRoute', (req, res) => {
    const { deviceId, routeName, destinations } = req.body;

    if (!deviceId || !routeName || !destinations || !Array.isArray(destinations)) {
        console.log('Datos inválidos para asignar ruta:', req.body);
        return res.status(400).json({ error: 'Datos incompletos o inválidos' });
    }

    const coordinates = JSON.stringify(destinations.map((dest, index) => ({
        order: index + 1,
        lat: dest.lat,
        lng: dest.lng
    })));

    const query = 'INSERT INTO routes (device_id, route_name, coordinates) VALUES (?, ?, ?)';
    db.query(query, [deviceId, routeName, coordinates], (err, result) => {
        if (err) {
            console.error('Error al guardar ruta:', err);
            return res.status(500).json({ error: 'Error al guardar la ruta' });
        }
        console.log(`Ruta "${routeName}" asignada a ${deviceId}`);
        res.json({ success: true, id: result.insertId });
    });
});

app.get('/api/routes', (req, res) => {
    const deviceId = req.query.deviceId;
    if (!deviceId) {
        console.log('Falta deviceId en solicitud de rutas');
        return res.status(400).json({ error: 'Se requiere deviceId' });
    }

    const query = 'SELECT route_name, coordinates FROM routes WHERE device_id = ? ORDER BY id DESC LIMIT 1';
    db.query(query, [deviceId], (err, results) => {
        if (err) {
            console.error('Error al obtener rutas:', err);
            return res.status(500).json({ error: 'Error al obtener rutas' });
        }
        if (results.length === 0) {
            console.log(`No se encontraron rutas para ${deviceId}`);
            return res.status(404).json({ error: 'No se encontraron rutas para este dispositivo' });
        }
        const destinations = JSON.parse(results[0].coordinates).map(coord => ({
            lat: coord.lat,
            lng: coord.lng
        }));
        res.json(destinations);
    });
});

// Iniciar el servidor
server.listen(port, '0.0.0.0', () => {
    console.log(`Servidor corriendo en puerto ${port}`);
});

// Manejo de errores no capturados
process.on('uncaughtException', (err) => {
    console.error('Error no capturado:', err);
});