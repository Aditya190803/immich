import {
  Column,
  CreateDateColumn,
  Generated,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { CloudStorageProvider } from 'src/enum';

@Table('cloud_storage_sync')
@Index({ columns: ['assetId', 'provider'], unique: true, where: '"assetId" IS NOT NULL' })
@Index({ columns: ['status'] })
export class CloudStorageSyncTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column()
  assetId!: string;

  @Column()
  localPath!: string;

  @Column()
  cloudPath!: string;

  @Column()
  provider!: CloudStorageProvider;

  @Column({ default: 'pending' })
  status!: Generated<'pending' | 'synced' | 'failed' | 'deleted'>;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ type: 'integer', default: 0 })
  attempts!: Generated<number>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  syncedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  deletedAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
