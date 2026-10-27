// Script para crear la base de datos y usuario reporting_service en MySQL k3s
// Ejecutar como: node scripts/create-db.mjs
// O desde la línea: kubectl exec -it <mysql-pod> -- mysql -u root -p -e "source scripts/create-db.mjs"
//
// Este es el patrón usado por treasury-service, purchasing-service, etc.

const readline = require('node:readline');
const { execSync } = require('node:child_process');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Solicitar contraseña de forma segura
function askPassword(preg) {
    return new Promise((resolve) => {
        rl.question(preg, (pass) => resolve(pass));
    });
}

async function main() {
    console.log('=== Creación de base de datos reporting_service ===\n');
    
    const dbPassword = await askPassword('Ingresa la contraseña para reporting_user: ');
    const confirmPassword = await askPassword('Confirma la contraseña: ');
    
    if (dbPassword !== confirmPassword) {
        console.error('❌ Las contraseñas no coinciden');
        process.exit(1);
    }
    
    // Usar la contraseña del root de MySQL en el clúster (por defecto root123 o el que tengas)
    const rootPassword = 'root123'; // Esto debería obtenerse del secreto mysql-basic-credentials
    
    const sqlCommands = [
        `CREATE DATABASE IF NOT EXISTS reporting_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
        `CREATE USER IF NOT EXISTS 'reporting_user'@'%' IDENTIFIED BY '${dbPassword}';`,
        `GRANT ALL PRIVILEGES ON reporting_db.* TO 'reporting_user'@'%';`,
        `FLUSH PRIVILEGES;`
    ];
    
    console.log('\nEjecutando comandos SQL...\n');
    
    try {
        // Intentar conectar al MySQL del clúster
        // La forma recomendada es a través del servicio mysql-basic
        const host = process.env.DB_HOST || 'mysql-basic';
        const port = process.env.DB_PORT || '3306';
        
        // Construir el comando mysql
        const cmd = `mysql -h ${host} -P ${port} -u root -p${rootPassword} -e "${sqlCommands.join(' ')}"`;
        execSync(cmd);
        console.log('✅ Base de datos y usuario created successfully');
        console.log(`\nBase de datos: reporting_db`);
        console.log(`Usuario: reporting_user${dbPassword ? ` (contraseña: ${dbPassword})` : ''}`);
    } catch (error) {
        console.error('❌ Error al crear la base de datos:', error.message);
        console.error('\nAlternativa: Conéctate manualmente a tu MySQL k3s y ejecuta:');
        console.log(`  CREATE DATABASE IF NOT EXISTS reporting_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
        console.log(`  CREATE USER IF NOT EXISTS 'reporting_user'@'%' IDENTIFIED BY '${dbPassword}';`);
        console.log(`  GRANT ALL PRIVILEGES ON reporting_db.* TO 'reporting_user'@'%';`);
        process.exit(1);
    } finally {
        rl.close();
    }
}

main().catch((err) => {
    console.error('Error fatal:', err);
    process.exit(1);
});