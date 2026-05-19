import { BadRequestException, Injectable } from '@nestjs/common';
import { OnEvent } from 'src/decorators';
import { mapAsset } from 'src/dtos/asset-response.dto';
import { JobCreateDto } from 'src/dtos/job.dto';
import { AssetType, AssetVisibility, JobName, JobStatus, ManualJobName, QueueName } from 'src/enum';
import { ArgsOf } from 'src/repositories/event.repository';
import { BaseService } from 'src/services/base.service';
import { JobItem } from 'src/types';
import { hexOrBufferToBase64 } from 'src/utils/bytes';

const asJobItem = (dto: JobCreateDto): JobItem => {
  switch (dto.name) {
    case ManualJobName.TagCleanup: {
      return { name: JobName.TagCleanup };
    }

    case ManualJobName.PersonCleanup: {
      return { name: JobName.PersonCleanup };
    }

    case ManualJobName.UserCleanup: {
      return { name: JobName.UserDeleteCheck };
    }

    case ManualJobName.MemoryCleanup: {
      return { name: JobName.MemoryCleanup };
    }

    case ManualJobName.MemoryCreate: {
      return { name: JobName.MemoryGenerate };
    }

    case ManualJobName.BackupDatabase: {
      return { name: JobName.DatabaseBackup };
    }

    default: {
      throw new BadRequestException('Invalid job name');
    }
  }
};

@Injectable()
export class JobService extends BaseService {
  async create(dto: JobCreateDto): Promise<void> {
    await this.jobRepository.queue(asJobItem(dto));
  }

  @OnEvent({ name: 'JobRun' })
  async onJobRun(...[queueName, job]: ArgsOf<'JobRun'>) {
    try {
      if (await this.deferMachineLearningJob(queueName, job)) {
        return;
      }

      await this.eventRepository.emit('JobStart', queueName, job);
      const response = await this.jobRepository.run(job);
      await this.eventRepository.emit('JobSuccess', { job, response });
      if (response && typeof response === 'string' && [JobStatus.Success, JobStatus.Skipped].includes(response)) {
        await this.onDone(job);
      }
    } catch (error: Error | any) {
      await this.eventRepository.emit('JobError', { job, error });
    } finally {
      await this.eventRepository.emit('JobComplete', queueName, job);
    }
  }

  private isMachineLearningJob(job: JobItem) {
    return [
      JobName.SmartSearchQueueAll,
      JobName.SmartSearch,
      JobName.AssetDetectFacesQueueAll,
      JobName.AssetDetectFaces,
      JobName.FacialRecognitionQueueAll,
      JobName.FacialRecognition,
      JobName.AssetDetectDuplicatesQueueAll,
      JobName.AssetDetectDuplicates,
      JobName.OcrQueueAll,
      JobName.Ocr,
    ].includes(job.name);
  }

  private isWithinSchedule(startTime: string, endTime: string) {
    const [startHour, startMinute] = startTime.split(':').map(Number);
    const [endHour, endMinute] = endTime.split(':').map(Number);
    const now = new Date();
    const current = now.getHours() * 60 + now.getMinutes();
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;

    return start <= end ? current >= start && current < end : current >= start || current < end;
  }

  private async hasBusyQueues(currentQueue: QueueName) {
    const busyQueues = [
      QueueName.BackgroundTask,
      QueueName.MetadataExtraction,
      QueueName.ThumbnailGeneration,
      QueueName.VideoConversion,
      QueueName.Library,
      QueueName.Migration,
      QueueName.Sidecar,
      QueueName.CloudSync,
    ].filter((queueName) => queueName !== currentQueue);

    const active = await Promise.all(busyQueues.map((queueName) => this.jobRepository.isActive(queueName)));
    return active.some(Boolean);
  }

  private async deferMachineLearningJob(queueName: QueueName, job: JobItem) {
    if (!this.isMachineLearningJob(job)) {
      return false;
    }

    const config = await this.getConfig({ withCache: false });
    const schedule = config.machineLearning.schedule;
    if (!schedule.enabled) {
      return false;
    }

    const outsideWindow = !this.isWithinSchedule(schedule.startTime, schedule.endTime);
    const busy = schedule.onlyWhenIdle && (await this.hasBusyQueues(queueName));
    if (!outsideWindow && !busy) {
      return false;
    }

    const delay = schedule.deferDelayMinutes * 60 * 1000;
    this.logger.debug(
      `Deferring ${job.name} for ${schedule.deferDelayMinutes} minutes (${outsideWindow ? 'outside schedule' : 'server busy'})`,
    );
    await this.jobRepository.queue({
      name: job.name,
      data: { ...(job.data || {}), delay },
    } as JobItem);
    return true;
  }

  /**
   * Queue follow up jobs
   */
  private async onDone(item: JobItem) {
    switch (item.name) {
      case JobName.SidecarCheck: {
        await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: item.data });
        break;
      }

      case JobName.SidecarWrite: {
        await this.jobRepository.queue({
          name: JobName.AssetExtractMetadata,
          data: { id: item.data.id, source: 'sidecar-write' },
        });
        break;
      }

      case JobName.StorageTemplateMigrationSingle: {
        if (item.data.source === 'upload' || item.data.source === 'copy') {
          await this.jobRepository.queue({ name: JobName.AssetGenerateThumbnails, data: item.data });
        }
        break;
      }

      case JobName.PersonGenerateThumbnail: {
        const { id } = item.data;
        const person = await this.personRepository.getById(id);
        if (person) {
          this.websocketRepository.clientSend('on_person_thumbnail', person.ownerId, person.id);
        }
        break;
      }

      case JobName.AssetEditThumbnailGeneration: {
        const asset = await this.assetRepository.getById(item.data.id);
        const edits = await this.assetEditRepository.getWithSyncInfo(item.data.id);

        if (asset) {
          this.websocketRepository.clientSend('AssetEditReadyV2', asset.ownerId, {
            asset: {
              id: asset.id,
              ownerId: asset.ownerId,
              originalFileName: asset.originalFileName,
              thumbhash: asset.thumbhash ? hexOrBufferToBase64(asset.thumbhash) : null,
              checksum: hexOrBufferToBase64(asset.checksum),
              fileCreatedAt: asset.fileCreatedAt,
              fileModifiedAt: asset.fileModifiedAt,
              createdAt: asset.createdAt,
              localDateTime: asset.localDateTime,
              duration: asset.duration,
              type: asset.type,
              deletedAt: asset.deletedAt,
              isFavorite: asset.isFavorite,
              visibility: asset.visibility,
              livePhotoVideoId: asset.livePhotoVideoId,
              stackId: asset.stackId,
              libraryId: asset.libraryId,
              width: asset.width,
              height: asset.height,
              isEdited: asset.isEdited,
            },
            edit: edits,
          });
        }

        break;
      }

      case JobName.AssetGenerateThumbnails: {
        if (!item.data.notify && item.data.source !== 'upload') {
          break;
        }

        const [asset] = await this.assetRepository.getByIdsWithAllRelationsButStacks([item.data.id]);
        if (!asset) {
          this.logger.warn(`Could not find asset ${item.data.id} after generating thumbnails`);
          break;
        }

        const jobs: JobItem[] = [
          { name: JobName.SmartSearch, data: item.data },
          { name: JobName.AssetDetectFaces, data: item.data },
          { name: JobName.Ocr, data: item.data },
        ];

        if (asset.type === AssetType.Video) {
          jobs.push({ name: JobName.AssetEncodeVideo, data: item.data });
        }

        await this.jobRepository.queueAll(jobs);
        if (asset.visibility === AssetVisibility.Timeline || asset.visibility === AssetVisibility.Archive) {
          this.websocketRepository.clientSend('on_upload_success', asset.ownerId, mapAsset(asset));
          if (asset.exifInfo) {
            const exif = asset.exifInfo;
            this.websocketRepository.clientSend('AssetUploadReadyV2', asset.ownerId, {
              // TODO remove `on_upload_success` and then modify the query to select only the required fields)
              asset: {
                id: asset.id,
                ownerId: asset.ownerId,
                originalFileName: asset.originalFileName,
                thumbhash: asset.thumbhash ? hexOrBufferToBase64(asset.thumbhash) : null,
                checksum: hexOrBufferToBase64(asset.checksum),
                fileCreatedAt: asset.fileCreatedAt,
                fileModifiedAt: asset.fileModifiedAt,
                createdAt: asset.createdAt,
                localDateTime: asset.localDateTime,
                duration: asset.duration,
                type: asset.type,
                deletedAt: asset.deletedAt,
                isFavorite: asset.isFavorite,
                visibility: asset.visibility,
                livePhotoVideoId: asset.livePhotoVideoId,
                stackId: asset.stackId,
                libraryId: asset.libraryId,
                width: asset.width,
                height: asset.height,
                isEdited: asset.isEdited,
              },
              exif: {
                assetId: exif.assetId,
                description: exif.description,
                exifImageWidth: exif.exifImageWidth,
                exifImageHeight: exif.exifImageHeight,
                fileSizeInByte: exif.fileSizeInByte,
                orientation: exif.orientation,
                dateTimeOriginal: exif.dateTimeOriginal ? new Date(exif.dateTimeOriginal) : null,
                modifyDate: exif.modifyDate ? new Date(exif.modifyDate) : null,
                timeZone: exif.timeZone,
                latitude: exif.latitude,
                longitude: exif.longitude,
                projectionType: exif.projectionType,
                city: exif.city,
                state: exif.state,
                country: exif.country,
                make: exif.make,
                model: exif.model,
                lensModel: exif.lensModel,
                fNumber: exif.fNumber,
                focalLength: exif.focalLength,
                iso: exif.iso,
                exposureTime: exif.exposureTime,
                profileDescription: exif.profileDescription,
                rating: exif.rating,
                fps: exif.fps,
              },
            });
          }
        }

        break;
      }

      case JobName.SmartSearch: {
        if (item.data.source === 'upload') {
          await this.jobRepository.queue({ name: JobName.AssetDetectDuplicates, data: item.data });
        }
        break;
      }
    }
  }
}
