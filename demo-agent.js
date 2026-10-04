// Demo coding agent: behaves like a real agent and asks for approval along the way.
// Lets you try Çoban and give demos without a subscription or an internet connection.
// Speaks the language picked in the Çoban panel (COBAN_LANG), English by default.

const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, resolve));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const c = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
};

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// The approval prompt keeps a "(y/n)"-style ending in every language so Çoban can answer it.
// The "✓ … " finished line matches Çoban's done detection in all four languages.
const TEXT = {
  en: {
    banner: 'Çoban demo agent', help: 'Type a task and press Enter. Type "exit" to quit.', task: 'Task',
    run: 'Run this command?', proceed: 'Proceed? (y/n)', yes: 'y', no: 'n', running: 'Running the command',
    done: '✓ Task complete.', skipped: 'Skipped the command. What else can I do?', quit: ['exit', 'quit'],
    plans: [
      [['Reading the project', '● Read 14 files in src/.'], ['Writing the component', '● Wrote src/components/UsageChart.tsx.'], ['Running the tests', '● 23 tests passed, 0 failed.']],
      [['Reading the data job', '● Read jobs/backfill_events.py.'], ['Adding checkpoints', '● A checkpoint is now written every 60 seconds.']],
      [['Inspecting the build folder', '● build/ is 1.2 GB and full of stale output.'], ['Planning the cleanup', '● Clean up first, then push to the main branch.']],
    ],
  },
  tr: {
    banner: 'Çoban demo ajanı', help: 'Bir görev yaz ve Enter\'a bas. Çıkmak için "çık".', task: 'Görev',
    run: 'Komut çalıştırılsın mı?', proceed: 'Onaylıyor musun? (e/h)', yes: 'e', no: 'h', running: 'Komut çalışıyor',
    done: '✓ Görev tamamlandı.', skipped: 'Komut atlandı. Başka nasıl yardım edeyim?', quit: ['çık', 'cik', 'exit'],
    plans: [
      [['Projeyi inceliyor', '● src/ klasöründe 14 dosya okundu.'], ['Bileşeni yazıyor', '● src/components/UsageChart.tsx yazıldı.'], ['Testleri çalıştırıyor', '● 23 test geçti, 0 hata.']],
      [['Veri işini okuyor', '● jobs/backfill_events.py okundu.'], ['Kontrol noktası ekliyor', '● Artık her 60 saniyede kontrol noktası yazılıyor.']],
      [['Derleme klasörünü inceliyor', '● build/ klasörü 1,2 GB, eski çıktılarla dolu.'], ['Temizlik planı çıkarıyor', '● Önce temizlik, sonra ana dala gönderim yapılacak.']],
    ],
  },
  de: {
    banner: 'Çoban Demo-Agent', help: 'Gib eine Aufgabe ein und drücke Enter. "exit" zum Beenden.', task: 'Aufgabe',
    run: 'Diesen Befehl ausführen?', proceed: 'Fortfahren? (y/n)', yes: 'y', no: 'n', running: 'Befehl läuft',
    done: '✓ Aufgabe erledigt.', skipped: 'Befehl übersprungen. Was kann ich sonst tun?', quit: ['exit', 'beenden'],
    plans: [
      [['Lese das Projekt', '● 14 Dateien in src/ gelesen.'], ['Schreibe die Komponente', '● src/components/UsageChart.tsx geschrieben.'], ['Führe die Tests aus', '● 23 Tests bestanden, 0 fehlgeschlagen.']],
      [['Lese den Datenjob', '● jobs/backfill_events.py gelesen.'], ['Füge Checkpoints hinzu', '● Jetzt wird alle 60 Sekunden ein Checkpoint geschrieben.']],
      [['Prüfe den Build-Ordner', '● build/ ist 1,2 GB groß und voller alter Ausgaben.'], ['Plane das Aufräumen', '● Erst aufräumen, dann auf den Main-Branch pushen.']],
    ],
  },
  es: {
    banner: 'agente de demostración de Çoban', help: 'Escribe una tarea y pulsa Enter. Escribe "salir" para terminar.', task: 'Tarea',
    run: '¿Ejecutar este comando?', proceed: '¿Continuar? (y/n)', yes: 'y', no: 'n', running: 'Ejecutando el comando',
    done: '✓ Tarea completada.', skipped: 'Comando omitido. ¿Qué más puedo hacer?', quit: ['salir', 'exit'],
    plans: [
      [['Leyendo el proyecto', '● Leídos 14 archivos en src/.'], ['Escribiendo el componente', '● Escrito src/components/UsageChart.tsx.'], ['Ejecutando las pruebas', '● 23 pruebas superadas, 0 fallidas.']],
      [['Leyendo el trabajo de datos', '● Leído jobs/backfill_events.py.'], ['Añadiendo puntos de control', '● Ahora se escribe un punto de control cada 60 segundos.']],
      [['Revisando la carpeta de build', '● build/ ocupa 1,2 GB y está llena de salidas antiguas.'], ['Planificando la limpieza', '● Primero limpiar, luego hacer push a la rama principal.']],
    ],
  },
};

const T = TEXT[(process.env.COBAN_LANG || 'en').slice(0, 2)] || TEXT.en;
const DURATIONS = [[2500, 3500, 3000], [2000, 4000], [2000, 2500]];
const COMMANDS = ['npm run deploy -- --env staging', 'python jobs/backfill_events.py --from 2024-01-01', 'rm -rf build/ && git push --force origin main'];

async function think(label, ms) {
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < ms) {
    const secs = ((Date.now() - start) / 1000).toFixed(0);
    process.stdout.write(`\r${c.cyan(FRAMES[i++ % FRAMES.length])} ${label}… ${c.dim(`(${secs}s)`)}   `);
    await sleep(100);
  }
  process.stdout.write('\r\x1b[2K');
}

async function runTask(task, n) {
  const idx = n % COMMANDS.length;
  console.log(c.dim(`\n${T.task}: ${task}`));
  for (let i = 0; i < T.plans[idx].length; i++) {
    const [label, done] = T.plans[idx][i];
    await think(label, DURATIONS[idx][i]);
    console.log(done);
  }

  console.log(`\n${c.bold(T.run)}`);
  console.log(`  ${c.yellow(COMMANDS[idx])}`);
  let answer = '';
  while (![T.yes, T.no].includes(answer)) {
    answer = (await ask(`${c.bold(T.proceed)} `)).trim().toLowerCase();
  }

  if (answer === T.yes) {
    await think(T.running, 3000);
    console.log(c.green(T.done));
  } else {
    console.log(c.dim(T.skipped));
  }
}

async function main() {
  // "Demo Agent v1.0" stays the same in every language: Çoban recognizes the agent by it.
  console.log(c.bold('\nDemo Agent v1.0') + c.dim(`  (${T.banner})`));
  console.log(c.dim(T.help));
  let n = 0;
  for (;;) {
    const task = (await ask(`\n${c.cyan('❯')} `)).trim();
    if (!task) continue;
    if (T.quit.includes(task.toLowerCase())) break;
    await runTask(task, n++);
  }
  rl.close();
}

main();
