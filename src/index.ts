
import 'dotenv/config';
import { app } from './app';
import { startRetentionScheduler } from './services/retention.service';

const PORT = 8080;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  startRetentionScheduler();
});
